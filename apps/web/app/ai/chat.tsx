'use client';

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@ds-nfl/adapters';
import { useFormAction } from '@/lib/use-form-action';
import { leagueChat, type ChatState } from './actions';

const EXAMPLES = [
  'Why is my lineup set this way?',
  'Is there news I should worry about?',
  'Which waiver pickup helps me most?',
  'Any tight ends worth adding?',
  'Explain the best trade idea.',
];

/** "Tyler Shough, Devaughn Vele and 8 more". */
function lookedUpLabel(names: readonly string[]): string {
  return names.length <= 6 ? names.join(', ') : `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`;
}

export function Chat({
  leagueKey,
  week,
  initial,
  enabled,
  providerLabel,
}: {
  leagueKey: string;
  week: number;
  initial: readonly ChatMessage[];
  enabled: boolean;
  providerLabel: string;
}) {
  // Not a plain form action: React's reset would wipe the question when the
  // model or the league fails, which is exactly when it needs asking again.
  const [state, send, pending] = useFormAction<ChatState>(leagueChat, { messages: initial });
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // After an answer lands: clear the box and keep the newest message in view.
  useEffect(() => {
    if (input.current) input.current.value = '';
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [state.messages.length]);

  return (
    <div className="chat">
      <div className="chat__log" aria-live="polite">
        {state.messages.length === 0 && !pending && (
          <p className="chat__empty">
            Ask anything about this league. Answers come only from the brief below and the players
            the app looks up for your question, and any answer that uses a number not in them is
            withheld.
          </p>
        )}
        {state.messages.map((m, i) => (
          <div
            key={`${m.at}-${i}`}
            className={`chat__msg chat__msg--${m.role}${m.withheld ? ' chat__msg--withheld' : ''}`}
          >
            <p>{m.content}</p>
            {m.role === 'user' && m.lookedUp && m.lookedUp.length > 0 && (
              <span className="ai__attr">Looked up: {lookedUpLabel(m.lookedUp)}</span>
            )}
            {m.role === 'assistant' && m.author && <span className="ai__attr">{m.author}</span>}
          </div>
        ))}
        {pending && (
          <div className="chat__msg chat__msg--assistant chat__msg--pending">
            <p>Asking {providerLabel}…</p>
          </div>
        )}
        <div ref={end} />
      </div>

      {state.error && <p className="ai__error">{state.error}</p>}

      {enabled ? (
        <form onSubmit={send} className="chat__form">
          <input type="hidden" name="league" value={leagueKey} />
          <input type="hidden" name="week" value={week} />
          <textarea
            ref={input}
            name="question"
            className="field__input chat__input"
            rows={2}
            placeholder="Ask about your lineup, the waiver wire, trades, or news"
            required
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="chat__actions">
            <div className="chat__examples">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chip"
                  onClick={() => {
                    if (input.current) {
                      input.current.value = q;
                      input.current.focus();
                    }
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
            <button className="btn btn--primary" type="submit" disabled={pending}>
              {pending ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </form>
      ) : (
        <p className="ai__off">
          Chatting needs an AI provider. <a href="/connect#ai">Turn on AI explanations</a> — the
          brief below is visible either way.
        </p>
      )}

      {state.messages.length > 0 && (
        <form onSubmit={send}>
          <input type="hidden" name="league" value={leagueKey} />
          <input type="hidden" name="intent" value="clear" />
          <button className="btn btn--ghost" type="submit" disabled={pending}>
            Clear this conversation
          </button>
        </form>
      )}
    </div>
  );
}
