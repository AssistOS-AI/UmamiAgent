export class AnalyticsTracker {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.invalidate();
    }
}
