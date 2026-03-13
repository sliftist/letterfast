import preact from "preact";
import { css } from "typesafecss";
import { URLParam } from "sliftutils/render-utils/URLParam";
import { observer } from "sliftutils/render-utils/observer";
import { LetterFastGame } from "./LetterFastGame";
import { GameConfig } from "./GameConfig";
import { GameLobby } from "./GameLobby";
import { GameResults } from "./GameResults";

export const pageURL = new URLParam("page");
export const joinGameIdURL = new URLParam("join", "");

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
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    render() {
        let pages = [
            {
                key: "",
                content: <GameConfig />
            },
            {
                key: "game",
                content: <LetterFastGame />
            },
            {
                key: "lobby",
                content: <GameLobby />
            },
            {
                key: "results",
                content: <GameResults />
            },
        ];

        let page = pages.find(p => p.key === pageURL.value) || pages[0];

        return (
            <div className={css.size("100vw", "100vh")
                .background("linear-gradient(135deg, #1a0b2e 0%, #2d1b69 50%, #1a0b2e 100%)")
                .overflowAuto
            }>
                {page.content}
            </div>
        );
    }
}
