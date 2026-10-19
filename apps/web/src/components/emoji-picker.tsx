"use client";

import { Button } from "@crm/design-system/components/button";
import { useTranslations } from "next-intl";
import { useState } from "react";

// Common emoji set — no dependency; the OS renders glyphs natively.
const EMOJIS = (
  "😀 😄 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😢 😭 😡 👍 👎 🙏 👏 💪 🤝 ✅ ❌ " +
  "❤️ 💔 🔥 ✨ 🎉 🎂 ⚽ 🚀 💡 📌 📎 🕐 ☀️ 🌙 ⭐ 💬 📞 📷 🎵 🔒 💰"
).split(" ");

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const t = useTranslations("composer");
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("emojisTitle")}
        data-testid="emoji-button"
      >
        😊
      </Button>
      {open && (
        <div
          className="bg-raised shadow-raised absolute bottom-full left-0 z-10 mb-1 grid w-64 grid-cols-8 gap-0.5 rounded-md border p-1"
          data-testid="emoji-grid"
        >
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="hover:bg-raised rounded-xs p-1 text-lg"
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
