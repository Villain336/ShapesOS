// ShapesOS Desktop: the typing fallback, a small input near the cursor.
// Typed questions carry no screenshot: the screen is captured only while
// the talk key is held.

import { ArrowUp, X } from "lucide-react";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { desktop } from "./bridge";

function Ask() {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(
    () =>
      desktop.on("ask:reset", () => {
        setText("");
        requestAnimationFrame(() => ref.current?.focus());
      }),
    [],
  );
  const submit = () => {
    if (!text.trim()) return;
    desktop.send("ask:submit", text);
    setText("");
  };
  return (
    <main>
      <form
        className="ask-box"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={ref}
          autoFocus
          aria-label="Ask ShapesOS"
          placeholder="Ask ShapesOS or say what to do"
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") desktop.send("ask:close");
          }}
        />
        <button type="button" className="btn btn-quiet btn-icon" aria-label="Close" onClick={() => desktop.send("ask:close")}>
          <X size={18} aria-hidden="true" />
        </button>
        <button type="submit" className="btn btn-primary btn-icon aos-press" aria-label="Send" disabled={!text.trim()}>
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </form>
      <p className="ask-help">Typed questions don't include a screenshot. Hold the talk key to show your screen.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Ask />);
