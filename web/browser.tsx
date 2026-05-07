import * as preact from "preact";
import { observable } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css, isNode } from "typesafecss";
import { list } from "socket-function/src/misc";
import { enableHotReloading } from "sliftutils/builders/hotReload";
import { URLParam } from "sliftutils/render-utils/URLParam";
import { Page } from "./Page";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";


async function main() {
    if (isNode()) return;
    if (location.origin.startsWith("file:") || location.hostname === "localhost") {
        await enableHotReloading({ port: 9877 });
    }
    configureMobxNextFrameScheduler();
    preact.render(<Page />, document.getElementById("app")!);
}

main().catch(console.error);

