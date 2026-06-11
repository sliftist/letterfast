import * as preact from "preact";
import { observable } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css, isNode } from "typesafecss";

const MAX_ERRORS = 20;

const errorState = observable({
    errors: [] as { message: string; at: number }[],
    expanded: false,
});

export function reportError(message: string) {
    errorState.errors.push({ message, at: Date.now() });
    if (errorState.errors.length > MAX_ERRORS) {
        errorState.errors.shift();
    }
}

function formatErrorEvent(e: ErrorEvent): string {
    const err = e.error as { stack?: string; message?: string; name?: string } | null | undefined;
    if (err && err.stack) return err.stack;

    const location = (e.filename || e.lineno || e.colno)
        ? `\n    at ${e.filename || "<unknown>"}:${e.lineno || "?"}:${e.colno || "?"}`
        : "";
    const msg = err?.message || e.message || (err && String(err)) || "Unknown error";
    const isSanitized = e.message === "Script error." || e.message === "Script error";
    const hint = isSanitized
        ? "\n    (Browser hid the stack — likely a cross-origin script without CORS headers. " +
        "Add `crossorigin=\"anonymous\"` on the <script> and ensure the file is served with " +
        "`Access-Control-Allow-Origin`.)"
        : "";
    return `${msg}${location}${hint}`;
}

function formatRejection(reason: unknown): string {
    if (reason instanceof Error) return reason.stack || `${reason.name}: ${reason.message}`;
    if (reason && typeof reason === "object") {
        const r = reason as { stack?: string; message?: string };
        if (r.stack) return r.stack;
        if (r.message) return r.message;
        try { return JSON.stringify(reason); } catch { /* fallthrough */ }
    }
    return String(reason);
}

export function installGlobalErrorHandlers() {
    if (isNode()) return;
    window.addEventListener("error", e => {
        reportError(formatErrorEvent(e));
        // Also log so the devtools console has the raw event (browsers
        // expose more context there than the global handler ever gets).
        console.error("[global error]", e.error || e.message, e);
    });
    window.addEventListener("unhandledrejection", e => {
        reportError(formatRejection(e.reason));
        console.error("[unhandled rejection]", e.reason);
    });
}

@observer
export class ErrorToast extends preact.Component {
    render() {
        if (errorState.errors.length === 0) return null;
        if (!errorState.expanded) {
            return (
                <div
                    onClick={() => { errorState.expanded = true; }}
                    title="Tap to see errors"
                    className={css.fixed.bottom(12).left(12).zIndex(20000)
                        .hbox(6).alignItems("center")
                        .pad2(10, 6).borderRadius(20)
                        .hsl(0, 70, 35).colorhsl(0, 0, 100)
                        .fontSize(14).fontWeight("bold")
                        .cursor("pointer")
                        + ""}
                    style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.5)" }}
                >
                    ⚠ {errorState.errors.length}
                </div>
            );
        }
        return (
            <div
                className={css.fixed.bottom(12).left(12).zIndex(20000)
                    .vbox(8).pad2(12)
                    .maxHeight("60vh").overflowAuto
                    .hsl(0, 40, 16).colorhsl(0, 0, 100).borderRadius(8)
                    .fontSize(12)
                    + ""}
                style={{
                    maxWidth: "min(640px, calc(100vw - 24px))",
                    boxShadow: "0 2px 16px rgba(0,0,0,0.6)",
                    border: "1px solid rgba(255,100,100,0.5)",
                }}
            >
                <div className={css.hbox(8).alignItems("center").fillWidth + ""}>
                    <span className={css.fontSize(14).fontWeight("bold") + ""}>⚠ Errors ({errorState.errors.length})</span>
                    <button style={{ marginLeft: "auto" }} onClick={() => { errorState.expanded = false; }}>Minimize</button>
                    <button onClick={() => { errorState.errors = []; errorState.expanded = false; }}>Clear</button>
                </div>
                {errorState.errors.slice().reverse().map((err, i) => (
                    <pre
                        key={i}
                        style={{
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            margin: 0,
                            borderTop: "1px solid rgba(255,255,255,0.15)",
                            paddingTop: 6,
                            width: "100%",
                        }}
                    >
                        {new Date(err.at).toLocaleTimeString()} — {err.message}
                    </pre>
                ))}
            </div>
        );
    }
}
