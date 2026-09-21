'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormAction } from '@/lib/use-form-action';
import { saveAiSettings, type ConnectResult } from './actions';

type Provider = 'off' | 'claude' | 'ollama';

const OPTIONS: readonly { value: Provider; title: string; hint: string }[] = [
  {
    value: 'off',
    title: 'Off',
    hint: 'Recommendations work exactly the same. Nothing leaves this computer.',
  },
  {
    value: 'claude',
    title: 'Claude (claude-opus-5)',
    hint: 'Fast and clearly written. Each explanation is one short request, billed to your Anthropic account, sent only when you click.',
  },
  {
    value: 'ollama',
    title: 'Local model (Ollama)',
    hint: 'Free and private — runs on this computer. Slower: a 14B model can take a minute.',
  },
];

export function AiForm({
  provider,
  anthropicKeySet,
  ollamaUrl,
  ollamaModel,
  ollamaJudgmentModel,
  ollamaChatModel,
  ollamaSearchKeySet,
  installedModels,
  ollamaReachable,
}: {
  provider: Provider;
  anthropicKeySet: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  /** Null when judgement tasks use the same model. */
  ollamaJudgmentModel: string | null;
  /** Null when the chat uses the same model. */
  ollamaChatModel: string | null;
  ollamaSearchKeySet: boolean;
  installedModels: readonly string[];
  ollamaReachable: boolean;
}) {
  const [choice, setChoice] = useState<Provider>(provider);
  // Not a plain form action: React would reset the radios to the provider the
  // page first rendered with, so a saved choice would appear to revert to Off.
  const [result, submit, pending] = useFormAction<ConnectResult | null>(saveAiSettings, null, { refresh: true });
  const keyInput = useRef<HTMLInputElement>(null);
  const searchKeyInput = useRef<HTMLInputElement>(null);
  const removeSearchKey = useRef<HTMLInputElement>(null);

  // Saved keys are not left sitting in the fields; rejected ones stay to be fixed.
  useEffect(() => {
    if (!result?.ok) return;
    if (keyInput.current) keyInput.current.value = '';
    if (searchKeyInput.current) searchKeyInput.current.value = '';
    if (removeSearchKey.current) removeSearchKey.current.checked = false;
  }, [result]);

  return (
    <form onSubmit={submit} className="form">
      {result && (
        <div className={`notice${result.ok ? '' : ' notice--error'}`}>
          <span className={`notice__tag${result.ok ? '' : ' notice__tag--error'}`}>
            {result.ok ? 'Saved' : 'Failed'}
          </span>
          <span>{result.message}</span>
        </div>
      )}

      <fieldset className="choice">
        <legend className="field__label">Who writes the explanations</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className="choice__option">
            <input
              type="radio"
              name="provider"
              value={o.value}
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
            />
            <span>
              <strong>{o.title}</strong>
              <span className="field__hint">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {choice === 'claude' && (
        <label className="field">
          <span className="field__label">Anthropic API key</span>
          <input
            ref={keyInput}
            className="field__input field__input--mono"
            name="anthropicApiKey"
            type="password"
            autoComplete="off"
            placeholder={anthropicKeySet ? 'Stored — leave blank to keep it' : 'sk-ant-…'}
            required={!anthropicKeySet}
          />
          <span className="field__hint">
            From console.anthropic.com. It is checked with a free request before it is saved, and it
            is never sent back to this page.
          </span>
        </label>
      )}

      {choice === 'ollama' && (
        <>
          <div className="form__grid">
            <label className="field">
              <span className="field__label">Ollama address</span>
              <input className="field__input" name="ollamaUrl" defaultValue={ollamaUrl} />
              <span className="field__hint">
                {ollamaReachable ? 'Ollama is answering here.' : `Ollama is not answering at ${ollamaUrl}.`}
              </span>
            </label>
            <label className="field">
              <span className="field__label">Model</span>
              {installedModels.length > 0 ? (
                <select className="field__input" name="ollamaModel" defaultValue={ollamaModel}>
                  {installedModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="field__input" name="ollamaModel" defaultValue={ollamaModel} />
              )}
              <span className="field__hint">
                {installedModels.length > 0
                  ? 'Models installed on this computer.'
                  : 'Install one with: ollama pull <model>'}
              </span>
            </label>
          </div>

          <label className="field">
            <span className="field__label">Model for the news check and waiver picks</span>
            {installedModels.length > 0 ? (
              <select className="field__input" name="ollamaJudgmentModel" defaultValue={ollamaJudgmentModel ?? ''}>
                <option value="">Same as above</option>
                {installedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="field__input"
                name="ollamaJudgmentModel"
                defaultValue={ollamaJudgmentModel ?? ''}
                placeholder="Same as above"
              />
            )}
            <span className="field__hint">
              The news check, waiver picks, and the news read on Evaluate a player run in the background
              and can move projections, so a slower model that reasons costs less waiting there. Chat and
              explanations stay on the model above, for speed.
            </span>
          </label>

          <label className="field">
            <span className="field__label">Model for the League AI chat</span>
            {installedModels.length > 0 ? (
              <select className="field__input" name="ollamaChatModel" defaultValue={ollamaChatModel ?? ''}>
                <option value="">Same as above</option>
                {installedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input className="field__input" name="ollamaChatModel" defaultValue={ollamaChatModel ?? ''} placeholder="Same as above" />
            )}
            <span className="field__hint">
              A model that reasons, such as deepseek-r1:14b, can talk through pickups and trades, and shows its
              reasoning under each answer. It is slower than one fine-tuned to answer straight from the facts.
            </span>
          </label>

          <div className="field">
            <label className="field__label" htmlFor="ollamaApiKey">
              Ollama web search key (optional)
            </label>
            <input
              ref={searchKeyInput}
              id="ollamaApiKey"
              className="field__input field__input--mono"
              name="ollamaApiKey"
              type="password"
              autoComplete="off"
              placeholder={ollamaSearchKeySet ? 'Stored — leave blank to keep it' : 'Paste a key to add web search'}
            />
            <span className="field__hint">
              Adds Ollama&apos;s web search to the news check, alongside ESPN and Google News: page text
              for each player, not just headlines. It needs a free ollama.com account; create a key at
              ollama.com/settings/keys. Only player names are searched. The key is checked with one
              small search before it is saved, and never sent back to this page.
            </span>
            {ollamaSearchKeySet && (
              <label className="choice__inline">
                <input ref={removeSearchKey} type="checkbox" name="removeOllamaKey" /> Remove the stored key
              </label>
            )}
          </div>
        </>
      )}

      <div className="form__actions">
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
