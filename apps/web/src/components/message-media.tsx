// Media bubble — the proxy route streams bytes from storage or WAHA.
import type { MessageContent, MessageWithAuthorRow } from "@crm/core/messaging";
import { Icon } from "@crm/design-system/components/icon";
import Image from "next/image";
import type { getTranslations } from "next-intl/server";

import { AudioPlayer } from "@/components/audio-player";

type T = Awaited<ReturnType<typeof getTranslations>>;
type MediaItem = Extract<MessageContent, { type: "media" }>;

function ImageMedia({ content, src, t }: { content: MediaItem; src: string; t: T }) {
  const isSticker = content.mimeType === "image/webp";
  if (isSticker) {
    // Sticker (image/webp): no chrome box — natural size, transparency
    // kept, animation preserved via unoptimized.
    return (
      <Image
        src={src}
        alt={t("stickerAlt")}
        width={160}
        height={160}
        unoptimized
        className="h-auto max-w-40"
        data-testid="sticker"
      />
    );
  }
  // Reserved box (message content carries no dimensions) — `fill` +
  // `object-contain` shows the whole image without a layout shift.
  return (
    <div className="bg-page/60 relative aspect-video w-64 max-w-full overflow-hidden rounded-md">
      <Image
        src={src}
        alt={content.caption ?? t("imageAlt")}
        fill
        // eslint-disable-next-line no-restricted-syntax -- next/image sizes attribute (runtime hint, not styling)
        sizes="256px"
        unoptimized
        className="object-contain"
      />
    </div>
  );
}

function AudioMedia({ src, transcript }: { src: string; transcript: unknown }) {
  return (
    <>
      <AudioPlayer src={src} />
      {typeof transcript === "string" && transcript !== "" && (
        <p
          className="text-ink-muted rounded-xs border-l-2 border-current/40 pl-2 text-xs italic"
          data-testid="audio-transcript"
        >
          {transcript}
        </p>
      )}
    </>
  );
}

export function MediaContent({ msg, t, tc }: { msg: MessageWithAuthorRow; t: T; tc: T }) {
  const content = msg.content as MediaItem;
  const meta = msg.metadata as { transcript?: string; unsupportedMedia?: boolean };
  const src = `/api/media/${msg.id}`;
  if (meta.unsupportedMedia) {
    // Ingest flagged a media event with no fetchable source — a real row
    // (ordering preserved) rendered as an internal note, not a broken box.
    return (
      <p className="text-ink-muted flex items-center gap-1.5 text-xs italic">
        <Icon name="file" className="size-3.5 shrink-0" />
        {t("unsupportedMedia")}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {content.mediaKind === "image" && <ImageMedia content={content} src={src} t={t} />}
      {content.mediaKind === "video" && (
        <video controls src={src} className="max-w-full rounded-md">
          <track kind="captions" label={tc("noCaptions")} />
        </video>
      )}
      {content.mediaKind === "audio" && <AudioMedia src={src} transcript={meta.transcript} />}
      {content.mediaKind === "document" && (
        <a
          href={src}
          className="flex items-center gap-2 underline underline-offset-2"
          data-testid="media-document"
        >
          📄 {content.filename ?? t("document")}
        </a>
      )}
      {content.caption && <p className="text-sm whitespace-pre-wrap">{content.caption}</p>}
    </div>
  );
}
