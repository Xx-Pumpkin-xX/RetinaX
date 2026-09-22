import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { MessageCircleQuestionMark } from 'lucide-react'
import { api } from "./api.js";

const GENERAL_KEY = "general";

function contextFor(pathname) {
  const match = pathname.match(/^\/cases\/([^/]+)$/);
  if (!match || match[1] === "new") return { key: GENERAL_KEY, caseId: null };
  return { key: `case:${match[1]}`, caseId: match[1] };
}

export default function ChatbotPopup() {
  const location = useLocation();
  const context = useMemo(() => contextFor(location.pathname), [location.pathname]);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [conversations, setConversations] = useState({ [GENERAL_KEY]: [] });
  const [busyKey, setBusyKey] = useState(null);
  const [errors, setErrors] = useState({});

  const messages = conversations[context.key] || [];
  const busy = busyKey === context.key;
  const error = errors[context.key] || null;

  async function send(e) {
    e?.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;

    const history = messages.map(({ role, content }) => ({ role, content }));
    const nextUserMessage = { role: "user", content: message };

    setConversations((prev) => ({
      ...prev,
      [context.key]: [...(prev[context.key] || []), nextUserMessage],
    }));
    setDraft("");
    setBusyKey(context.key);
    setErrors((prev) => ({ ...prev, [context.key]: null }));

    try {
      let result;

      if (context.caseId) {
        try {
          result = await api.chat(context.caseId, message, history);
        } catch (err) {
          // A case-specific discussion is available only after the clinician
          // has saved an assessment. Before that, keep the global assistant
          // usable instead of making the floating chatbot a dead control.
          if (!String(err.message).includes("Save your assessment")) throw err;
          result = await api.assistantChat([...history, nextUserMessage]);
        }
      } else {
        result = await api.assistantChat([...history, nextUserMessage]);
      }

      setConversations((prev) => ({
        ...prev,
        [context.key]: [
          ...(prev[context.key] || []),
          { role: "assistant", content: result.reply },
        ],
      }));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [context.key]: err.message }));
    } finally {
      setBusyKey((key) => (key === context.key ? null : key));
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="chatbot-fab"
        aria-label="Open RetinaX AI"
        onClick={() => setOpen(true)}
        title="Ask AI assistant"
      >
        <span className="chatbot-fab-icon" aria-hidden="true">
          <MessageCircleQuestionMark className="chatbot-fab-question" />
        </span>
      </button>
    );
  }

  return (
    <section className="chatbot-popup" aria-label="RetinaX AI assistant">
      <div className="chatbot-header">
        <div>
          <div className="chatbot-title">RetinaX AI</div>
          <div className="chatbot-context">
            {context.caseId ? "Case-aware assistant" : "Application assistant"}
          </div>
        </div>
        <button
          type="button"
          className="chatbot-close"
          aria-label="Close RetinaX AI"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </div>

      <div className="chatbot-messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="chatbot-empty">
            {context.caseId
              ? "Ask about RetinaX or discuss this case after saving your assessment."
              : "Ask how to use RetinaX, its workflow, grades, statuses, or explanations."}
          </div>
        )}

        {messages.map((item, index) => (
          <div
            key={`${item.role}-${index}`}
            className={`chatbot-message ${item.role === "user" ? "is-user" : "is-assistant"}`}
          >
            <div className="chatbot-message-label">
              {item.role === "user" ? "You" : "RetinaX AI"}
            </div>
            <div>{item.content}</div>
          </div>
        ))}

        {busy && <div className="chatbot-thinking">RetinaX AI is thinking…</div>}
      </div>

      {error && <div className="chatbot-error">{error}</div>}

      <form className="chatbot-form" onSubmit={send}>
        <textarea
          className="input chatbot-input"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={context.caseId ? "Ask about this case or RetinaX…" : "Ask RetinaX AI…"}
        />
        <button className="btn" type="submit" disabled={busy || !draft.trim()}>
          {busy ? "Responding…" : "Send"}
        </button>
      </form>

      <div className="chatbot-footnote">
        Decision-support prototype. The assistant does not replace the clinician's assessment.
      </div>
    </section>
  );
}
