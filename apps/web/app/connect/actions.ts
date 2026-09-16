'use server';

import { revalidatePath } from 'next/cache';
import {
  AdapterFailure,
  EspnReader,
  activeLeague,
  describeError,
  leagueKey,
  listLeagues,
  readStore,
  removeLeague,
  saveLeague,
  savedEspnCookies,
  verifyOllamaSearchKey,
  writeStore,
} from '@ds-nfl/adapters';
import { DEFAULT_OLLAMA_URL, LlmError, listOllamaModels, verifyClaudeKey } from '@ds-nfl/llm';
import { DEFAULT_OLLAMA_MODEL } from '@/lib/ai';

export interface ConnectResult {
  readonly ok: boolean;
  readonly message: string;
}

/** ESPN's SWID is a GUID in braces; people routinely paste it without them. */
function normalizeSwid(raw: string): string {
  return raw && !raw.startsWith('{') ? `{${raw}}` : raw;
}

function failure(e: unknown): ConnectResult {
  const message =
    e instanceof AdapterFailure ? describeError(e.error) : e instanceof Error ? e.message : String(e);
  return { ok: false, message };
}

/**
 * Add a league, or update one already connected, but only after proving it works.
 *
 * Storing unverified credentials is how you end up with a "connected" league
 * that fails on every page load. The league and team are read once here;
 * nothing is written unless that succeeds. The league then becomes active.
 *
 * Cookies left blank reuse the ones saved with the active league. ESPN cookies
 * belong to the account, not the league, so a second league on the same
 * account needs no new secrets.
 */
export async function connectEspn(
  _prev: ConnectResult | null,
  form: FormData,
): Promise<ConnectResult> {
  const saved = savedEspnCookies();

  const leagueId = String(form.get('leagueId') ?? '').trim();
  const teamId = String(form.get('teamId') ?? '').trim();
  const season = Number(form.get('season') ?? new Date().getFullYear());
  const espnS2 = String(form.get('espnS2') ?? '').trim() || (saved?.espnS2 ?? '');
  const swid = normalizeSwid(String(form.get('swid') ?? '').trim() || (saved?.swid ?? ''));

  if (!leagueId || !teamId) {
    return { ok: false, message: 'Fill in the league id and team id.' };
  }
  if (!espnS2 || !swid) {
    return { ok: false, message: 'Paste your espn_s2 and SWID cookies. None are saved yet.' };
  }
  if (!Number.isFinite(season)) {
    return { ok: false, message: 'Season must be a year, for example 2026.' };
  }

  try {
    const reader = new EspnReader({ espnS2, swid });
    const ref = { platform: 'espn' as const, leagueId, season, teamId };

    const league = await reader.getLeague(ref);
    // Confirm the team id too — a valid league with a wrong team is a confusing
    // half-failure that would otherwise only appear on the lineup page.
    const teams = await reader.getTeams(ref);
    const mine = teams.find((t) => t.isMine);
    if (!mine) {
      return {
        ok: false,
        message: `Connected to ${league.name}, but team ${teamId} is not in it. Teams are ${teams
          .map((t) => t.teamId)
          .join(', ')}.`,
      };
    }

    const existed = listLeagues().some((l) => leagueKey(l) === leagueKey(ref));
    saveLeague({
      platform: 'espn',
      leagueId,
      teamId,
      season,
      espnS2,
      swid,
      leagueName: league.name,
      teamName: mine.name,
    });
    revalidatePath('/', 'layout');

    return {
      ok: true,
      message: `${existed ? 'Updated' : 'Connected to'} ${league.name}. It is now the active league.`,
    };
  } catch (e) {
    // ESPN answers 401 for a league these cookies cannot see. When adding a
    // league, a wrong id or season is a likelier cause than expired cookies.
    if (e instanceof AdapterFailure && e.error.kind === 'auth-required') {
      return {
        ok: false,
        message: `ESPN refused league ${leagueId} for ${season}. Check the league id and season. If they are right, this ESPN account is not a member of that league, or its cookies have expired.`,
      };
    }
    return failure(e);
  }
}

/**
 * Replace expired ESPN cookies. They are checked against the active league
 * first; saving then refreshes every connected league on the same account.
 */
export async function renewCookies(
  _prev: ConnectResult | null,
  form: FormData,
): Promise<ConnectResult> {
  const league = activeLeague();
  if (!league) return { ok: false, message: 'Connect a league first.' };

  const espnS2 = String(form.get('espnS2') ?? '').trim();
  const swid = normalizeSwid(String(form.get('swid') ?? '').trim());
  if (!espnS2 || !swid) return { ok: false, message: 'Paste both cookies.' };

  try {
    const reader = new EspnReader({ espnS2, swid });
    await reader.getLeague({
      platform: 'espn',
      leagueId: league.leagueId,
      season: league.season,
      teamId: league.teamId,
    });
    saveLeague({ ...league, espnS2, swid });
    revalidatePath('/', 'layout');

    const updated = listLeagues().filter((l) => l.swid === swid).length;
    return {
      ok: true,
      message: `Cookies saved for ${updated} ${updated === 1 ? 'league' : 'leagues'} on this ESPN account.`,
    };
  } catch (e) {
    return failure(e);
  }
}

/** Forget a league's saved connection. Its AI conversation file is kept. */
export async function forgetLeague(key: string): Promise<void> {
  removeLeague(key);
  revalidatePath('/', 'layout');
}

/**
 * Save the AI provider, but only after proving it works — the same rule as the
 * ESPN cookies. A key is checked with a free model-list request; a local model
 * must actually be installed in a running Ollama.
 */
export async function saveAiSettings(
  _prev: ConnectResult | null,
  form: FormData,
): Promise<ConnectResult> {
  const provider = String(form.get('provider') ?? 'off');
  const store = readStore();
  const previous = store.ai;

  if (provider === 'off') {
    writeStore({ ...store, ai: { ...previous, provider: 'off' } });
    revalidatePath('/', 'layout');
    return { ok: true, message: 'AI explanations are off. Every recommendation works exactly the same.' };
  }

  if (provider === 'claude') {
    const newKey = String(form.get('anthropicApiKey') ?? '').trim();
    const key = newKey || previous?.anthropicApiKey;
    if (!key) return { ok: false, message: 'Paste an Anthropic API key. None is stored yet.' };
    if (newKey) {
      try {
        await verifyClaudeKey(newKey);
      } catch (error) {
        return { ok: false, message: error instanceof LlmError ? error.message : String(error) };
      }
    }
    writeStore({ ...store, ai: { ...previous, provider: 'claude', anthropicApiKey: key } });
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Claude will write explanations, one short request each time you ask.' };
  }

  if (provider === 'ollama') {
    const url = String(form.get('ollamaUrl') ?? '').trim() || DEFAULT_OLLAMA_URL;
    const model = String(form.get('ollamaModel') ?? '').trim() || DEFAULT_OLLAMA_MODEL;
    try {
      const installed = await listOllamaModels(url);
      if (!installed.includes(model)) {
        return {
          ok: false,
          message: `Ollama is running, but "${model}" is not installed. Installed: ${installed.join(', ') || 'none'}. Run: ollama pull ${model}`,
        };
      }
    } catch (error) {
      return { ok: false, message: error instanceof LlmError ? error.message : String(error) };
    }
    // The optional web search key, checked with one small search before it is kept.
    const newSearchKey = String(form.get('ollamaApiKey') ?? '').trim();
    if (newSearchKey) {
      try {
        await verifyOllamaSearchKey(newSearchKey);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const { ollamaApiKey: storedSearchKey, ...rest } = previous ?? { provider: 'off' as const };
    const searchKey = newSearchKey || (form.get('removeOllamaKey') === 'on' ? undefined : storedSearchKey);

    writeStore({
      ...store,
      ai: {
        ...rest,
        provider: 'ollama',
        ollamaUrl: url,
        ollamaModel: model,
        ...(searchKey ? { ollamaApiKey: searchKey } : {}),
      },
    });
    revalidatePath('/', 'layout');
    return {
      ok: true,
      message: `${model} will write explanations, running on this computer.${
        searchKey ? ' News checks also use Ollama web search.' : ''
      }`,
    };
  }

  return { ok: false, message: 'Pick a provider.' };
}
