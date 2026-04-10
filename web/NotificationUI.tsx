import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { observable } from "mobx";
import { notificationState, markAsRead, Notification, removeNotification } from "./NotificationState";
import { showGameOver } from "./GameOver";
import { GameOverState } from "./GameState";

@observer
export class NotificationUI extends preact.Component {
    synced = observable({
        isOpen: false,
        toastNotification: undefined as Notification | undefined,
        toastTimer: undefined as number | undefined,
    });

    lastNotificationCount = 0;

    componentDidMount() {
        document.addEventListener("click", this.handleClickOutside);
        this.lastNotificationCount = notificationState.notifications.length;
    }

    componentWillUnmount() {
        document.removeEventListener("click", this.handleClickOutside);
        if (this.synced.toastTimer) {
            clearTimeout(this.synced.toastTimer);
        }
    }

    componentDidUpdate() {
        if (notificationState.notifications.length > this.lastNotificationCount) {
            const newNotification = notificationState.notifications[notificationState.notifications.length - 1];
            this.showToast(newNotification);
        }
        this.lastNotificationCount = notificationState.notifications.length;
    }

    showToast(notification: Notification) {
        if (this.synced.toastTimer) {
            clearTimeout(this.synced.toastTimer);
        }
        
        this.synced.toastNotification = notification;
        this.synced.toastTimer = window.setTimeout(() => {
            this.synced.toastNotification = undefined;
            this.synced.toastTimer = undefined;
        }, 15000);
    }

    handleClickOutside = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target.closest(".notification-container")) {
            this.synced.isOpen = false;
        }
    };

    handleNotificationClick = (notification: Notification) => {
        markAsRead(notification.id);
        
        if (notification.type === "challenge-completed") {
            const data = notification.data;
            const gameOverState: GameOverState = {
                grid: data.grid,
                playerResults: [
                    {
                        id: "challenger",
                        score: data.creatorScore,
                        matchedWords: data.creatorWords,
                        isSelf: true,
                    },
                    {
                        id: "player",
                        score: data.playerScore,
                        matchedWords: data.playerWords,
                        isSelf: false,
                    }
                ],
                totalPossibleScore: data.totalPossibleScore,
                totalPossibleWords: data.totalPossibleWords,
            };
            showGameOver(gameOverState, () => {});
        }

        this.synced.isOpen = false;
    };

    render() {
        const unreadCount = notificationState.notifications.filter(n => !n.read).length;

        if (notificationState.notifications.length === 0) {
            return undefined;
        }

        return (
            <div className={css.fixed.top(20).right(20).zIndex(1000).vbox(8).alignItems("end") + " notification-container"}>
                <style>{`
                    @keyframes slideIn {
                        from {
                            opacity: 0;
                            transform: translateX(20px);
                        }
                        to {
                            opacity: 1;
                            transform: translateX(0);
                        }
                    }
                    .toast-notification {
                        animation: slideIn 300ms ease-out;
                    }
                `}</style>
                
                <button
                    className={css.relative.size(40, 40).borderRadius(8)
                        .hbox(0).justifyContent("center")
                        .hsl(240, 30, 20).colorhsl(0, 0, 100)
                        .cursor("pointer")
                        + (this.synced.isOpen && css.hsl(240, 40, 30))
                    }
                    onClick={(e) => {
                        e.stopPropagation();
                        this.synced.isOpen = !this.synced.isOpen;
                    }}
                >
                    <div className={css.fontSize(20)}>🔔</div>
                    {unreadCount > 0 && (
                        <div
                            className={css.absolute.pos(-8, -8)
                                .size(20, 20).borderRadius(10)
                                .hsl(0, 80, 50).colorhsl(0, 0, 100)
                                .fontSize(12).fontWeight("bold")
                                .hbox(0).justifyContent("center")
                            }
                        >
                            {unreadCount}
                        </div>
                    )}
                </button>

                {this.synced.toastNotification && (
                    <div
                        className={css.width(280).pad2(12).borderRadius(8)
                            .hsl(240, 40, 20).colorhsl(0, 0, 100)
                            .boxShadow("0 4px 20px rgba(0, 0, 0, 0.5)")
                            .vbox(6).cursor("pointer")
                            + css.hslhover(240, 50, 25)
                            + " toast-notification"
                        }
                        onClick={() => {
                            this.handleNotificationClick(this.synced.toastNotification!);
                            this.synced.toastNotification = undefined;
                            if (this.synced.toastTimer) {
                                clearTimeout(this.synced.toastTimer);
                                this.synced.toastTimer = undefined;
                            }
                        }}
                    >
                        <div className={css.fontSize(14).fontWeight("bold")}>
                            Challenge Completed!
                        </div>
                        <div className={css.fontSize(12).opacity(0.8)}>
                            {this.synced.toastNotification.summary}
                        </div>
                    </div>
                )}

                {this.synced.isOpen && (
                    <div
                        className={css.absolute.pos(50, 0)
                            .width(320).maxHeight(400)
                            .hsl(240, 30, 15).borderRadius(8)
                            .boxShadow("0 4px 20px rgba(0, 0, 0, 0.5)")
                            .overflowAuto.vbox(0)
                            .colorhsl(0, 0, 100)
                        }
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={css.pad2(16).fontSize(18).fontWeight("bold")
                            .borderBottom("1px solid rgba(255, 255, 255, 0.1)")
                        }>
                            Notifications
                        </div>

                        {notificationState.notifications.length === 0 && (
                            <div className={css.pad2(20).textAlign("center").opacity(0.5)}>
                                No notifications
                            </div>
                        )}

                        {notificationState.notifications.slice().reverse().map(notification => (
                            <div
                                key={notification.id}
                                className={css.pad2(16).cursor("pointer")
                                    .borderBottom("1px solid rgba(255, 255, 255, 0.1)")
                                    .hbox(12).alignItems("start")
                                    + (!notification.read && css.hsl(240, 40, 20))
                                    + (notification.read && css.opacity(0.6))
                                    + css.hslhover(240, 50, 25)
                                }
                                onClick={() => this.handleNotificationClick(notification)}
                            >
                                <div className={css.vbox(4).flexGrow(1)}>
                                    <div className={css.fontSize(14).fontWeight("bold")}>
                                        Challenge Completed!
                                    </div>
                                    <div className={css.fontSize(12).opacity(0.8)}>
                                        {notification.summary}
                                    </div>
                                    <div className={css.fontSize(11).opacity(0.5)}>
                                        {new Date(notification.timestamp).toLocaleTimeString()}
                                    </div>
                                </div>
                                <button
                                    className={css.size(24, 24).borderRadius(4)
                                        .hbox(0).justifyContent("center")
                                        .hsl(0, 0, 30).colorhsl(0, 0, 100)
                                        .cursor("pointer").fontSize(14)
                                        + css.hslhover(0, 0, 40)
                                    }
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        removeNotification(notification.id);
                                    }}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }
}
