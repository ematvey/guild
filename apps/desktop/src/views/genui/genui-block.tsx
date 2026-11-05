// One `openui` fenced block of a message, rendered as live components.
// A block is a dialog: it takes one answer, then its controls settle.
// The program can only instantiate the Generated UI library; it has no
// tools (Query/Mutation have no provider) and no HTML. A click leaves the
// block only as a message sent in the open thread or a web link opened
// outside the app.

import { Component, useCallback, useContext, useState, type ReactNode } from "react";
import { Renderer, type ParseResult } from "@openuidev/react-lang";
import { openExternal } from "../../lib/open-external";
import { GENUI_FENCES } from "@guild/genui";
import { genuiReactLibrary } from "./components";
import {
  GenuiAnswerContext,
  GenuiHostContext,
  GenuiInertContext,
  GenuiPlacementContext,
  genuiOutcome,
  type GenuiEvent,
} from "./actions";

/** Whether a fenced code block's language is a Generated UI block. */
export function isGenuiLanguage(className: unknown): boolean {
  if (typeof className !== "string") return false;
  return className.split(/\s+/).some((c) => GENUI_FENCES.some((lang) => c === `language-${lang}`));
}

export function GenuiBlock({ source }: { source: string }) {
  const host = useContext(GenuiHostContext);
  const { streaming, answer } = useContext(GenuiPlacementContext);
  const [empty, setEmpty] = useState(false);
  // The block's answer as this view sent it, until the thread's own user
  // message arrives: a second click in between finds the block settled.
  const [sent, setSent] = useState<string | null>(null);
  const settledAnswer = answer ?? sent;
  const inert = host === null || streaming || settledAnswer !== null;
  const onAction = useCallback(
    (event: GenuiEvent) => {
      const outcome = genuiOutcome(event);
      if (outcome.kind === "open") openExternal(outcome.url);
      else if (outcome.kind === "send" && host !== null) {
        setSent(outcome.text);
        host.send(outcome.text);
      }
    },
    [host],
  );
  const onParseResult = useCallback((result: ParseResult | null) => setEmpty(result?.root == null), []);
  // A settled block that produced nothing renderable reads as the code the
  // agent wrote, so the user still sees what was said.
  if (empty && !streaming) return <GenuiSource source={source} />;
  return (
    <GenuiErrorBoundary source={source}>
      <div className="not-prose my-3 flex flex-col gap-3 text-sm [overflow-wrap:normal]" data-genui>
        <GenuiInertContext.Provider value={inert}>
          <GenuiAnswerContext.Provider value={settledAnswer}>
            <Renderer
              response={source}
              library={genuiReactLibrary}
              isStreaming={streaming}
              onAction={onAction as never}
              onParseResult={onParseResult}
              toolProvider={null}
              publishObservability={false}
            />
          </GenuiAnswerContext.Provider>
        </GenuiInertContext.Provider>
      </div>
    </GenuiErrorBoundary>
  );
}

function GenuiSource({ source }: { source: string }) {
  return (
    <pre>
      <code>{source}</code>
    </pre>
  );
}

class GenuiErrorBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { source: string }) {
    if (this.state.failed && prev.source !== this.props.source) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? <GenuiSource source={this.props.source} /> : this.props.children;
  }
}
