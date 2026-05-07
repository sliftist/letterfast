import preact from "preact";
import { css } from "typesafecss";
import { URLParam } from "sliftutils/render-utils/URLParam";
import { observer } from "sliftutils/render-utils/observer";
import { LetterFastGame } from "./LetterFastGame";
import { GridCell } from "./GameState";
import { NotificationUI } from "./NotificationUI";

export const pageURL = new URLParam("page", "game");
export const joinGameIdURL = new URLParam("join", "");
export const challengeURL = new URLParam<{
    grid: GridCell[][];
    challengerWords: { word: string; points: number }[];
    challengerScore: number;
    totalPossibleWords: number;
    totalPossibleScore: number;
    gameDuration: number;
    challengeId?: string;
    signature?: string;
    publicKey?: string;
} | undefined>("challenge", undefined);

@observer
export class Page extends preact.Component {
    onKeyDown = (e: KeyboardEvent) => {
        // Ignore if it is for an input, text area, etc
        let ignore = (
            e.target instanceof HTMLInputElement && e.target.type !== "file" ||
            e.target instanceof HTMLTextAreaElement ||
            e.target instanceof HTMLSelectElement
        );
        if (ignore) return;

        let key = e.key;
        if (e.ctrlKey) key = "Ctrl+" + key;
        if (e.shiftKey) key = "Shift+" + key;
        let hotkeyDataAttribute = `[data-hotkey="${key}"]`;
        let el = document.querySelector<HTMLElement>(hotkeyDataAttribute);
        if (el) {
            e.stopPropagation();
            e.preventDefault();
            console.log("Found hotkey", e.key, el);
            el.click();
        }
    };
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    render() {
        return (
            <div className={css.width("100svw").height("100svh")
                .background("linear-gradient(135deg, #1a0b2e 0%, #2d1b69 50%, #1a0b2e 100%)")
                .overflowHidden
            }>
                <NotificationUI />
                <LetterFastGame />
            </div>
        );
    }
}
