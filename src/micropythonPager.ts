/**
 * A less-like pager for displaying text files read from MicroPython devices.
 *
 * Keybindings:
 *   q / Q           — quit
 *   Space / f       — page down
 *   b               — page up
 *   j / ↓ / Enter   — line down
 *   k / ↑           — line up
 *   d               — half-page down
 *   u               — half-page up
 *   g / <           — top of file
 *   G / >           — bottom of file
 *   /               — enter search (Enter to confirm, Esc to cancel)
 *   n               — next search hit
 *   N               — previous search hit
 */
export class MicroPythonPager {
    private readonly lines: string[];
    private topLine = 0;

    private searchTerm = '';
    private searchHits: number[] = [];   // sorted indices into this.lines
    private searchHitIndex = -1;

    private searchMode = false;
    private searchInput = '';

    constructor(
        content: string,
        private rows: number,
        private cols: number,
        private readonly fileName: string,
        private readonly writeFn: (text: string) => void,
        private readonly onClose: () => void,
    ) {
        const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        this.lines = normalized.split('\n');
        // trim trailing empty line produced by split
        if (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') { this.lines.pop(); }
    }

    setDimensions(rows: number, cols: number): void {
        this.rows = rows;
        this.cols = cols;
        this.render();
    }

    open(): void { this.render(); }

    handleInput(data: string): void {
        if (this.searchMode) {
            this.handleSearchInput(data);
            return;
        }

        const ps = this.pageSize();
        switch (data) {
            // Quit
            case 'q': case 'Q': case '\x1b':
                this.exit(); return;

            // Page down
            case ' ': case 'f': case '\x06': case '\x1b[6~':
                this.scroll(ps); break;

            // Page up
            case 'b': case '\x02': case '\x1b[5~':
                this.scroll(-ps); break;

            // Line down
            case 'j': case '\x1b[B': case '\r':
                this.scroll(1); break;

            // Line up
            case 'k': case '\x1b[A':
                this.scroll(-1); break;

            // Half page down
            case 'd': case '\x04':
                this.scroll(Math.floor(ps / 2)); break;

            // Half page up
            case 'u': case '\x15':
                this.scroll(-Math.floor(ps / 2)); break;

            // Top
            case 'g': case '<': case '\x1b[H': case '\x1b[1~':
                this.topLine = 0; this.render(); break;

            // Bottom
            case 'G': case '>': case '\x1b[F': case '\x1b[4~':
                this.topLine = Math.max(0, this.lines.length - ps);
                this.render(); break;

            // Enter search
            case '/':
                this.searchMode = true;
                this.searchInput = '';
                this.renderSearchPrompt(); break;

            // Next / previous hit
            case 'n': this.nextHit(1); break;
            case 'N': this.nextHit(-1); break;
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private pageSize(): number { return Math.max(1, this.rows - 1); }

    private scroll(delta: number): void {
        const ps = this.pageSize();
        const maxTop = Math.max(0, this.lines.length - ps);
        this.topLine = Math.max(0, Math.min(this.topLine + delta, maxTop));
        this.render();
    }

    private render(): void {
        const ps = this.pageSize();
        const out: string[] = ['\x1b[2J\x1b[H']; // clear + cursor home

        for (let i = 0; i < ps; i++) {
            const lineIdx = this.topLine + i;
            if (lineIdx >= this.lines.length) {
                out.push('\x1b[34m~\x1b[0m');
            } else {
                out.push(this.renderLine(this.lines[lineIdx]));
            }
            out.push('\r\n');
        }

        out.push(this.buildStatusBar());
        this.writeFn(out.join(''));
    }

    private renderLine(line: string): string {
        const expanded = line.replace(/\t/g, '    ');
        const display = expanded.slice(0, this.cols);
        if (!this.searchTerm) { return display; }

        const lower = this.searchTerm.toLowerCase();
        const lowerDisp = display.toLowerCase();
        let result = '';
        let i = 0;
        while (i < display.length) {
            const idx = lowerDisp.indexOf(lower, i);
            if (idx === -1) { result += display.slice(i); break; }
            result += display.slice(i, idx);
            result += `\x1b[1;33m${display.slice(idx, idx + lower.length)}\x1b[0m`;
            i = idx + lower.length;
        }
        return result;
    }

    private buildStatusBar(): string {
        const ps = this.pageSize();
        const endLine = Math.min(this.topLine + ps, this.lines.length);
        const pct = this.lines.length === 0 ? 100
            : Math.round((endLine / this.lines.length) * 100);
        const searchPart = this.searchTerm ? `  /${this.searchTerm}` : '';
        const hitsPart = this.searchHits.length > 0
            ? ` [${this.searchHitIndex + 1}/${this.searchHits.length}]` : '';
        const bar = ` ${this.fileName}${searchPart}${hitsPart}  L${this.topLine + 1}-${endLine}/${this.lines.length} (${pct}%)  q:quit  /:search  n/N:next`;
        return `\x1b[7m${bar.slice(0, this.cols).padEnd(this.cols)}\x1b[0m`;
    }

    private renderSearchPrompt(): void {
        const prompt = `/${this.searchInput}`;
        this.writeFn(`\x1b[${this.rows};1H\x1b[K\x1b[7m${prompt.padEnd(this.cols)}\x1b[0m`);
    }

    private handleSearchInput(data: string): void {
        if (data === '\r') {
            this.searchTerm = this.searchInput;
            this.searchMode = false;
            this.searchInput = '';
            this.doSearch(this.searchTerm, this.topLine);
            this.render();
        } else if (data === '\x1b') {
            this.searchMode = false;
            this.searchInput = '';
            this.render();
        } else if (data === '\x7f' || data === '\x08') {
            if (this.searchInput.length > 0) {
                this.searchInput = this.searchInput.slice(0, -1);
                this.renderSearchPrompt();
            }
        } else if (data >= ' ') {
            this.searchInput += data;
            this.renderSearchPrompt();
        }
    }

    private doSearch(term: string, fromLine: number): void {
        this.searchHits = [];
        this.searchHitIndex = -1;
        if (!term) { return; }
        const lower = term.toLowerCase();
        this.searchHits = this.lines.reduce<number[]>((acc, l, i) => {
            if (l.toLowerCase().includes(lower)) { acc.push(i); }
            return acc;
        }, []);
        if (this.searchHits.length === 0) { return; }
        const idx = this.searchHits.findIndex(l => l >= fromLine);
        this.searchHitIndex = idx === -1 ? 0 : idx;
        this.topLine = Math.max(0, this.searchHits[this.searchHitIndex] - Math.floor(this.pageSize() / 2));
    }

    private nextHit(dir: 1 | -1): void {
        if (this.searchHits.length === 0) { return; }
        this.searchHitIndex = (this.searchHitIndex + dir + this.searchHits.length) % this.searchHits.length;
        this.topLine = Math.max(0, this.searchHits[this.searchHitIndex] - Math.floor(this.pageSize() / 2));
        this.render();
    }

    private exit(): void {
        this.writeFn('\x1b[2J\x1b[H');
        this.onClose();
    }
}
