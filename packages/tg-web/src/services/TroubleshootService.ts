import { WebClientService } from "arrmatura-web";
import { resources } from "tg-rc/web";
import { fill } from "../text/fill";

/**
 * Hands a failure to the vibe agent: opens the DevTools drawer on `ErrorBanner`,
 * closes that component's last session and sends the failure as a new one's first turn.
 * Mounted as `<TroubleshootService Ref="troubleshoot" vibe="@vibe" />`.
 */

/** The slice of `arrmatura-vibe`'s `VibeService` this calls. */
interface Vibe {
  readonly open: boolean;
  readonly draft: string;
  toggle(): void;
  target(tag: string): void;
  reset(): void;
  setDraft(event: { readonly value: string }): void;
  submit(): Promise<void>;
}

interface TroubleshootEvent {
  readonly error: string;
}

export class TroubleshootService extends WebClientService {
  declare vibe: Vibe;

  async start({ error }: TroubleshootEvent): Promise<void> {
    const { vibe } = this;
    if (!vibe.open) vibe.toggle();
    vibe.target("ErrorBanner");
    // `target` picks on a zero timeout, and `reset` and `submit` act on the picked component.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vibe.reset();
    // `submit` sends the draft, so whatever was being typed is put back after it.
    const typed = vibe.draft;
    vibe.setDraft({ value: fill(resources.common.troubleshootPrompt, { error }) });
    void vibe.submit();
    vibe.setDraft({ value: typed });
  }
}
