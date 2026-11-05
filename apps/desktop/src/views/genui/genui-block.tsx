// One `openui` fenced block of a message, rendered as live components.
// The program can only instantiate the Generated UI library; it has no
// tools (Query/Mutation have no provider) and no HTML. A click leaves the
// block only as a message sent in the open thread or a web link opened
// outside the app.

import { Component, useCallback, useContext, useState, type ReactNode } from "react";
import { Renderer, type ParseResult } from "@openuidev/react-lang";
import { openExternal } from "../../lib/open-external";
import { GENUI_FENCES } from "@guild/genui";
import { genuiReactLibrary } from "./components";
import { GenuiHostContext, GenuiStreamingContext, genuiOutcome, type GenuiEvent } from "./actions";

/** Whether a fenced code block's language is a Generated UI block. */
export function isGenuiLanguage(className: unknown): boolean {
  if (typeof className !== "string") return false;
  return className.split(/\s+/).some((c) => GENUI_FENCES.some((lang) => c === `language-${lang}`));
}

export function GenuiBlock({ source }: { source: string }) {
  const host = useContext(GenuiHostContext);
  const streaming = useContext(GenuiStreamingContext);
  const [empty, setEmpty] = useState(false);
  const onAction = useCallback(
    (event: GenuiEvent) => {
      const outcome = genuiOutcome(event);
      if (outcome.kind === "open") openExternal(outcome.url);
      else if (outcome.kind === "send") host?.send(outcome.text);
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
        <fieldset disabled={host === null} className="contents">
          <Renderer
            response={source}
            library={genuiReactLibrary}
            isStreaming={streaming}
            onAction={onAction as never}
            onParseResult={onParseResult}
            toolProvider={null}
            publishObservability={false}
          />
        </fieldset>
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
