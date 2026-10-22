import type { SourceType } from "tg-enums/sourceType";
import type { Link } from "./item";

export interface ItemIdParts {
  readonly sourceId: string;
  readonly tgMessageId: string;
}

/** One post as a reader hands it to scrape, whatever the transport. */
export interface ChannelPost {
  readonly id: string;

  readonly body: string;
  readonly links: readonly Link[];
  readonly image?: string;
  readonly forwardedFrom?: string;

  readonly postedAt?: string;
}

/** A transport scrape polls: the posts of one source after its cursor. */
export interface ChannelReader {
  readonly type: SourceType;

  read(channel: string, afterId: string | undefined): Promise<ChannelPost[]>;
}
