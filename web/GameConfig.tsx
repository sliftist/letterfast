import preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { Anchor } from "sliftutils/render-utils/Anchor";
import { pageURL } from "./Page";
import { changeGridSize, getCurrentGridSize } from "./GameState";
import { observable } from "mobx";

@observer
export class GameConfig extends preact.Component {
    synced = observable({
        customWidth: 4,
        customHeight: 4,
    });

    componentDidMount() {
        let size = getCurrentGridSize();
        this.synced.customWidth = size.width;
        this.synced.customHeight = size.height;
    }

    startGame(config: { width: number; height: number }) {
        changeGridSize(config);
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
                        Current: {currentSize.width}x{currentSize.height}
                    </div>

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Quick Modes
                        </div>
                        <div className={css.vbox(12)}>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={() => this.startGame({ width: 3, height: 3 })}
                            >
                                3x3 Classic Mode
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={() => this.startGame({ width: 4, height: 4 })}
                            >
                                4x4 Standard Mode
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={() => this.startGame({ width: 5, height: 5 })}
                            >
                                5x5 Extended Mode
                            </button>
                        </div>
                    </div>

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Custom Size (2-10)
                        </div>
                        <div className={css.hbox(12).alignItems("center").wrap}>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.customWidth}
                                onInput={(e) => {
                                    let value = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(value)) {
                                        this.synced.customWidth = value;
                                    }
                                }}
                                className={css.fontSize(20).pad2(12).width(80) + ""}
                            />
                            <div className={css.fontSize(20)}>x</div>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.customHeight}
                                onInput={(e) => {
                                    let value = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(value)) {
                                        this.synced.customHeight = value;
                                    }
                                }}
                                className={css.fontSize(20).pad2(12).width(80) + ""}
                            />
                            <button
                                className={css.fontSize(18).pad2(12) + ""}
                                onClick={() => {
                                    if (this.synced.customWidth >= 2 && this.synced.customWidth <= 10
                                        && this.synced.customHeight >= 2 && this.synced.customHeight <= 10) {
                                        this.startGame({ width: this.synced.customWidth, height: this.synced.customHeight });
                                    }
                                }}
                            >
                                Start {this.synced.customWidth}x{this.synced.customHeight} Game
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

