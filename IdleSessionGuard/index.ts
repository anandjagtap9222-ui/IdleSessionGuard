import { IInputs, IOutputs } from "./generated/ManifestTypes";

type SessionStatus = "Active" | "Warning" | "Idle";

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_LENGTH = 276.46; // circumference of the ring (2 x pi x 44)
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "pointerdown", "keydown", "touchstart", "wheel", "scroll"];

export class IdleSessionGuard implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private notifyOutputChanged: () => void;

    // Settings from the app
    private enabled = true;
    private timeoutMs = 15 * 60 * 1000;
    private warningMs = 60 * 1000;
    private showDialog = true;
    private resetKey: string | null = null;

    // Current state
    private lastActivity = Date.now();
    private status: SessionStatus = "Active";
    private secondsRemaining = 0;
    private timer = 0;

    // Dialog elements
    private overlay: HTMLDivElement;
    private titleEl: HTMLHeadingElement;
    private messageEl: HTMLParagraphElement;
    private countEl: HTMLDivElement;
    private progressEl: SVGCircleElement;
    private stayButton: HTMLButtonElement;

    // Kept as fields so the same functions can be removed again in destroy()
    private readonly onActivity = (): void => this.handleActivity();
    private readonly onVisibility = (): void => this.check();

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this.notifyOutputChanged = notifyOutputChanged;
        this.buildDialog();

        // Listen to the whole page, not just this control
        ACTIVITY_EVENTS.forEach((name) =>
            document.addEventListener(name, this.onActivity, { capture: true, passive: true })
        );
        // Check right away when the user comes back to the tab or wakes the device
        document.addEventListener("visibilitychange", this.onVisibility);

        this.timer = window.setInterval(() => this.check(), 1000);
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        const p = context.parameters;

        // Settings, with safe fallbacks
        const minutes = p.TimeoutMinutes.raw;
        this.timeoutMs = (minutes && minutes > 0 ? minutes : 15) * 60 * 1000;
        const warning = p.WarningSeconds.raw;
        this.warningMs = Math.min((warning !== null && warning >= 0 ? warning : 60) * 1000, this.timeoutMs);
        this.showDialog = p.ShowDialog.raw !== false;
        const enabled = p.Enabled.raw !== false;

        // Dialog text and color
        this.titleEl.textContent = p.DialogTitle.raw || "Are you still there?";
        this.messageEl.textContent = p.DialogMessage.raw || "";
        this.stayButton.textContent = p.StayButtonText.raw || "I'm still here";
        this.overlay.style.setProperty("--isg-accent", p.AccentColor.raw || "#0F6CBD");

        // Start a fresh session when the guard is switched back on,
        // or when the app changes ResetKey (for example after signing in again)
        const key = p.ResetKey.raw || "";
        const switchedOn = enabled && !this.enabled;
        const keyChanged = this.resetKey !== null && key !== this.resetKey;
        this.resetKey = key;
        this.enabled = enabled;
        if (switchedOn || keyChanged) {
            this.lastActivity = Date.now();
            this.setState("Active", 0);
        }

        this.check();
    }

    public getOutputs(): IOutputs {
        return { Status: this.status, SecondsRemaining: this.secondsRemaining };
    }

    public destroy(): void {
        window.clearInterval(this.timer);
        ACTIVITY_EVENTS.forEach((name) =>
            document.removeEventListener(name, this.onActivity, { capture: true })
        );
        document.removeEventListener("visibilitychange", this.onVisibility);
        this.overlay.remove();
    }

    // ---------- session logic ----------

    private handleActivity(): void {
        if (!this.enabled || this.status === "Idle") {
            return; // once Idle, only the app can reset the session
        }
        if (this.status === "Warning" && this.showDialog) {
            return; // the user must confirm in the dialog
        }
        this.lastActivity = Date.now();
        if (this.status === "Warning") {
            this.check();
        }
    }

    private stay(): void {
        this.lastActivity = Date.now();
        this.check();
    }

    private check(): void {
        if (!this.enabled) {
            this.setState("Active", 0);
            return;
        }
        if (this.status === "Idle") {
            return;
        }

        // Real clock time, so sleep and background tabs are counted correctly
        const timeLeft = this.timeoutMs - (Date.now() - this.lastActivity);

        if (timeLeft <= 0) {
            this.setState("Idle", 0);
        } else if (timeLeft <= this.warningMs) {
            this.setState("Warning", Math.ceil(timeLeft / 1000));
        } else {
            this.setState("Active", 0);
        }
    }

    private setState(status: SessionStatus, seconds: number): void {
        const changed = status !== this.status || seconds !== this.secondsRemaining;
        this.status = status;
        this.secondsRemaining = seconds;
        this.renderDialog();
        if (changed) {
            this.notifyOutputChanged(); // tells the app, which runs OnChange
        }
    }

    // ---------- dialog ----------

    private buildDialog(): void {
        this.overlay = document.createElement("div");
        this.overlay.className = "isg-overlay";
        this.overlay.setAttribute("role", "alertdialog");
        this.overlay.setAttribute("aria-modal", "true");

        const card = document.createElement("div");
        card.className = "isg-card";

        // Countdown ring
        const ring = document.createElement("div");
        ring.className = "isg-ring";
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        const track = document.createElementNS(SVG_NS, "circle");
        track.setAttribute("class", "isg-track");
        this.progressEl = document.createElementNS(SVG_NS, "circle");
        this.progressEl.setAttribute("class", "isg-progress");
        for (const circle of [track, this.progressEl]) {
            circle.setAttribute("cx", "50");
            circle.setAttribute("cy", "50");
            circle.setAttribute("r", "44");
            svg.appendChild(circle);
        }
        this.countEl = document.createElement("div");
        this.countEl.className = "isg-count";
        this.countEl.setAttribute("aria-live", "polite");
        ring.append(svg, this.countEl);

        this.titleEl = document.createElement("h2");
        this.titleEl.className = "isg-title";
        this.messageEl = document.createElement("p");
        this.messageEl.className = "isg-message";

        this.stayButton = document.createElement("button");
        this.stayButton.className = "isg-stay";
        this.stayButton.addEventListener("click", () => this.stay());

        card.append(ring, this.titleEl, this.messageEl, this.stayButton);
        this.overlay.appendChild(card);

        // Attach to the page so the dialog covers the whole app, not just this control
        document.body.appendChild(this.overlay);
    }

    private renderDialog(): void {
        const wasOpen = this.overlay.classList.contains("isg-open");
        const open = this.status === "Warning" && this.showDialog;
        this.overlay.classList.toggle("isg-open", open);

        if (open) {
            this.countEl.textContent = `${this.secondsRemaining}`;
            const fraction = this.warningMs > 0 ? (this.secondsRemaining * 1000) / this.warningMs : 0;
            this.progressEl.style.strokeDashoffset = `${RING_LENGTH * (1 - fraction)}`;
            if (!wasOpen) {
                this.stayButton.focus(); // Enter or Space confirms right away
            }
        }
    }
}