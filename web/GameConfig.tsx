import preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { Anchor } from "sliftutils/render-utils/Anchor";
import { pageURL } from "./Page";
import { changeGridSize, getCurrentGridSize } from "./LetterFastGame";
import { observable } from "mobx";

@observer
export class GameConfig extends preact.Component {
    synced = observable({
        customSize: 4,
    });

    componentDidMount() {
        this.synced.customSize = getCurrentGridSize();
    }

    startGame(size: number) {
        changeGridSize(size);
        pageURL.value = "game";
    }

    render() {
        let currentSize = getCurrentGridSize();

        return (
            <div className={css.fillBoth.vbox(20)
                .background("linear-gradient(135deg, #1a0b2e 0%, #2d1b69 50%, #1a0b2e 100%)")
                .pad2(40).colorhsl(0, 0, 100)
            }>
                <div className={css.vbox(24).maxWidth(600).marginAuto}>
                    <div className={css.fontSize(36).fontWeight("bold")}>
                        Select Game Mode
                    </div>
                    <div className={css.fontSize(18).opacity(0.8)}>
                        Current: {currentSize}x{currentSize}
                    </div>

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Quick Modes
                        </div>
                        <div className={css.vbox(12)}>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={() => this.startGame(3)}
                            >
                                3x3 Classic Mode
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={() => this.startGame(4)}
                            >
                                4x4 Standard Mode
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={() => this.startGame(5)}
                            >
                                5x5 Extended Mode
                            </button>
                        </div>
                    </div>

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Custom Size (2-10)
                        </div>
                        <div className={css.hbox(12).alignItems("center")}>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.customSize}
                                onChange={(e) => {
                                    let value = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(value)) {
                                        this.synced.customSize = value;
                                    }
                                }}
                                className={css.fontSize(20).pad2(12).width(80) + ""}
                            />
                            <button
                                className={css.fontSize(18).pad2(12) + ""}
                                onClick={() => {
                                    if (this.synced.customSize >= 2 && this.synced.customSize <= 10) {
                                        this.startGame(this.synced.customSize);
                                    }
                                }}
                            >
                                Start {this.synced.customSize}x{this.synced.customSize} Game
                            </button>
                        </div>
                    </div>

                    <Anchor params={[[pageURL, "game"]]}>
                        <button className={css.fontSize(18).pad2(12) + ""}>
                            Back to Game
                        </button>
                    </Anchor>
                </div>
            </div>
        );
    }
}

