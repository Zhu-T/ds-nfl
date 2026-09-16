/**
 * Web news reports, saved per league and week.
 *
 * A report is what Claude found and the app accepted, plus which findings the
 * manager switched off. It sits beside the credential store, like the League
 * AI conversations, and every page that prices players for that week reads it,
 * so the lineup, waivers, and trades all see the same adjustments.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NewsFinding } from '@ds-nfl/core';
import { dataDir } from './credentials.js';

export interface NewsReport {
  readonly leagueKey: string;
  readonly week: number;
  /** ISO time the search finished. */
  readonly checkedAt: string;
  readonly model: string;
  /** Web searches the check ran, each one billed. */
  readonly searches: number;
  readonly findings: readonly NewsFinding[];
  /** Findings dropped because they could not be verified, with the reason. */
  readonly rejected: readonly { readonly player: string; readonly reason: string }[];
  /** Player ids whose finding the manager switched off. */
  readonly disabled: readonly string[];
  /**
   * How the news was found: Claude searching the web itself, or a local model
   * reading news the app gathered. Absent in reports saved before the second existed.
   */
  readonly method?: 'web-search' | 'gathered';
  /** For gathered news, how many items the model read. */
  readonly itemsRead?: number;
  /** For gathered news, where it came from, e.g. ["ESPN", "Google News", "Ollama web search"]. */
  readonly sourcesUsed?: readonly string[];
}

function defaultDir(): string {
  return join(dataDir(), 'web-news');
}

function fileFor(leagueKey: string, week: number, dir: string): string {
  return join(dir, `${leagueKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}_w${week}.json`);
}

export function readNewsReport(leagueKey: string, week: number, dir: string = defaultDir()): NewsReport | null {
  const path = fileFor(leagueKey, week, dir);
  if (!existsSync(path)) return null;
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as NewsReport;
    return Array.isArray(report?.findings) ? { ...report, disabled: report.disabled ?? [] } : null;
  } catch {
    // A corrupt report reads as none, rather than breaking every page.
    return null;
  }
}

export function writeNewsReport(report: NewsReport, dir: string = defaultDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(report.leagueKey, report.week, dir), JSON.stringify(report, null, 2), 'utf8');
}

/** Switch one finding on or off. Returns the updated report, or null if there is none. */
export function setFindingEnabled(
  leagueKey: string,
  week: number,
  playerId: string,
  enabled: boolean,
  dir: string = defaultDir(),
): NewsReport | null {
  const report = readNewsReport(leagueKey, week, dir);
  if (!report) return null;
  const others = report.disabled.filter((id) => id !== playerId);
  const updated = { ...report, disabled: enabled ? others : [...others, playerId] };
  writeNewsReport(updated, dir);
  return updated;
}

export function clearNewsReport(leagueKey: string, week: number, dir: string = defaultDir()): void {
  rmSync(fileFor(leagueKey, week, dir), { force: true });
}

/** The findings in effect: all of them, less any the manager switched off. */
export function activeFindings(report: NewsReport | null): NewsFinding[] {
  if (!report) return [];
  return report.findings.filter((f) => !report.disabled.includes(f.playerId));
}
