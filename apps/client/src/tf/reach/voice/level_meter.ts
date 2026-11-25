/**
 * The recorder bar's live level: an `AnalyserNode` on the microphone stream, drawn as a row of
 * plain bars in the text colour, newest on the right. It redraws at most {@link METER_FPS} times a
 * second, never while the tab is hidden, and not at all for reduced motion (`meterAnimates()`):
 * then the row stays still.
 */

const BAR_COUNT = 28;
export const METER_FPS = 15;
const FRAME_MS = Math.ceil(1000 / METER_FPS);

/** Whether the meter moves: not for reduced motion (the system's or Trilium's), not in a hidden tab. */
export function meterAnimates({ reducedMotion, motionDisabled, hidden }: { reducedMotion: boolean; motionDisabled: boolean; hidden: boolean }) {
    return !reducedMotion && !motionDisabled && !hidden;
}

export class LevelMeter {
    private context: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private readonly levels: number[] = new Array(BAR_COUNT).fill(0);
    private timer = 0;
    private running = false;
    private readonly samples = new Uint8Array(256);
    private readonly reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    private readonly onVisibility = () => this.schedule();

    constructor(private readonly canvas: HTMLCanvasElement) {
        document.addEventListener("visibilitychange", this.onVisibility);
        this.reducedMotion?.addEventListener?.("change", this.onVisibility);
    }

    attach(stream: MediaStream | null) {
        this.detach();
        if (!stream) {
            return;
        }
        const AudioContextClass = window.AudioContext
            ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) {
            return;
        }
        try {
            this.context = new AudioContextClass();
            this.analyser = this.context.createAnalyser();
            this.analyser.fftSize = 256;
            this.source = this.context.createMediaStreamSource(stream);
            this.source.connect(this.analyser);
            void this.context.resume?.();
        } catch {
            this.detach();
        }
        this.schedule();
    }

    /** Draws the live level while `on`, a still row while not. */
    setRunning(on: boolean) {
        this.running = on;
        this.schedule();
        this.draw();
    }

    /** Stops drawing and lets go of the microphone and the page's listeners. */
    dispose() {
        this.detach();
        document.removeEventListener("visibilitychange", this.onVisibility);
        this.reducedMotion?.removeEventListener?.("change", this.onVisibility);
    }

    detach() {
        this.stopTimer();
        this.source?.disconnect();
        void this.context?.close().catch(() => {});
        this.source = null;
        this.analyser = null;
        this.context = null;
    }

    private animates() {
        return this.running && meterAnimates({
            reducedMotion: !!this.reducedMotion?.matches,
            motionDisabled: document.body.classList.contains("motion-disabled"),
            hidden: document.visibilityState === "hidden"
        });
    }

    private schedule() {
        if (!this.animates()) {
            this.stopTimer();
            return;
        }
        if (!this.timer) {
            this.timer = window.setInterval(this.frame, FRAME_MS);
        }
    }

    private stopTimer() {
        if (this.timer) {
            window.clearInterval(this.timer);
            this.timer = 0;
        }
    }

    private readonly frame = () => {
        if (!this.animates()) {
            this.stopTimer();
            return;
        }
        this.levels.shift();
        this.levels.push(this.read());
        this.draw();
    };

    private read() {
        if (!this.analyser) {
            return 0;
        }
        this.analyser.getByteTimeDomainData(this.samples);
        let sum = 0;
        for (const sample of this.samples) {
            const centred = (sample - 128) / 128;
            sum += centred * centred;
        }
        const rms = Math.sqrt(sum / this.samples.length);
        return Math.min(1, rms * 4);
    }

    private draw() {
        const canvas = this.canvas;
        const ratio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) {
            return;
        }
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return;
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = getComputedStyle(canvas).color;
        const gap = 2;
        const barWidth = Math.max(2, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
        for (const [ index, level ] of this.levels.entries()) {
            const barHeight = Math.max(2, Math.round(level * height));
            ctx.globalAlpha = this.running ? 1 : 0.4;
            ctx.fillRect(index * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
        }
    }
}
