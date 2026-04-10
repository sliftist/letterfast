import { observable } from "mobx";
import { GridCell } from "./GameState";

export interface ChallengeCompletedData {
    challengeId: string;
    grid: GridCell[][];
    playerScore: number;
    creatorScore: number;
    playerWords: { word: string; points: number }[];
    creatorWords: { word: string; points: number }[];
    totalPossibleScore: number;
    totalPossibleWords: number;
}

export interface Notification {
    id: string;
    type: "challenge-completed";
    summary: string;
    data: ChallengeCompletedData;
    timestamp: number;
    read: boolean;
}

export const notificationState = observable<{
    notifications: Notification[];
}>({
    notifications: [],
});

let notificationIdCounter = 0;

export function addNotification(notification: Omit<Notification, "id" | "timestamp" | "read">): void {
    const newNotification: Notification = {
        ...notification,
        id: `notification-${Date.now()}-${notificationIdCounter++}`,
        timestamp: Date.now(),
        read: false,
    };
    notificationState.notifications.push(newNotification);
}

export function markAsRead(id: string): void {
    const notification = notificationState.notifications.find(n => n.id === id);
    if (notification) {
        notification.read = true;
    }
}

export function getUnreadCount(): number {
    return notificationState.notifications.filter(n => !n.read).length;
}

export function clearAllNotifications(): void {
    notificationState.notifications = [];
}

export function removeNotification(id: string): void {
    notificationState.notifications = notificationState.notifications.filter(n => n.id !== id);
}
