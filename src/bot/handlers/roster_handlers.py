"""被动维护「群组花名册」的 Bot 处理器。

Bot API 没有 ``getChatMembers`` —— 没法主动枚举群成员。这里通过两个被动来源
累积一份本地花名册：

1. ``ChatMemberHandler``：监听 ``chat_member`` 更新（成员加入/退出/被踢/状态变更）。
   要求 Bot 在群里是管理员，且 ``Updater.start_polling`` 把 ``chat_member``
   纳入 ``allowed_updates``。``bot.py`` 已经传 ``Update.ALL_TYPES``，开箱即用。
2. 普通消息：群组里任何发言都会写一条「在群」证据，刷新 ``last_seen_at``。

只针对 ``TelegramConfig.GROUP_ID`` 里列出的群组生效；其它群的事件忽略，避免
把无关群塞进表。
"""
from __future__ import annotations

import logging
from typing import Optional, Union

from telegram import Update
from telegram.ext import (
    ContextTypes,
    ChatMemberHandler,
    MessageHandler,
    filters,
)

from src.config import TelegramConfig
from src.db.telegram_roster import TelegramRosterOperate

logger = logging.getLogger(__name__)


def _normalize_group_ids() -> set[str]:
    """把配置里的群组 ID 集合归一化成字符串集合。"""
    raw = TelegramConfig.GROUP_ID
    if not raw:
        return set()
    if isinstance(raw, (int, str)):
        raw = [raw]
    out: set[str] = set()
    for item in raw or []:
        if item is None or item == "":
            continue
        out.add(str(item).strip())
    return out


def _chat_matches_configured(chat) -> Optional[str]:
    """判断当前 chat 是否在配置的群组列表里；命中则返回标准化的 chat_id 字符串。

    ``chat`` 可能用数字 ID 也可能用 ``@username``，分别配。
    """
    if chat is None:
        return None
    configured = _normalize_group_ids()
    if not configured:
        return None
    chat_id = getattr(chat, "id", None)
    username = getattr(chat, "username", None)
    if chat_id is not None and str(chat_id) in configured:
        return str(chat_id)
    if username and f"@{username}" in configured:
        return f"@{username}"
    return None


async def _on_chat_member_update(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """成员状态变更（加入/退出/被踢/状态调整）。"""
    event = update.chat_member
    if event is None or event.chat is None or event.new_chat_member is None:
        return
    matched = _chat_matches_configured(event.chat)
    if not matched:
        return

    user = event.new_chat_member.user
    if not user or not getattr(user, "id", None):
        return

    status = (getattr(event.new_chat_member, "status", "") or "").lower()
    try:
        if status in ("left", "kicked"):
            await TelegramRosterOperate.mark_left(matched, int(user.id), status=status)
        else:
            await TelegramRosterOperate.upsert_member(
                matched, int(user.id),
                status=status or "member",
                is_bot=bool(getattr(user, "is_bot", False)),
            )
    except Exception as exc:  # pragma: no cover - DB 写入失败不应影响 Bot 主循环
        logger.warning(f"花名册写入失败 (chat={matched}, user={user.id}): {exc}")


async def _on_group_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """群里任何消息 → 顺手把发件人写进花名册。"""
    msg = update.effective_message
    if msg is None or msg.chat is None or msg.from_user is None:
        return
    matched = _chat_matches_configured(msg.chat)
    if not matched:
        return
    try:
        await TelegramRosterOperate.upsert_member(
            matched, int(msg.from_user.id),
            status="member",  # 能发言至少不是 left/kicked
            is_bot=bool(getattr(msg.from_user, "is_bot", False)),
        )
    except Exception as exc:  # pragma: no cover
        logger.debug(f"花名册（消息观察）写入失败: {exc}")


def register(bot) -> None:
    """挂到 bot.application 上；只在配置了群组时才注册，避免空转。"""
    if not _normalize_group_ids():
        logger.info("未配置 TelegramConfig.GROUP_ID，跳过花名册被动收集")
        return

    app = bot.application
    # ChatMemberHandler 抓 chat_member 更新（不抓 my_chat_member，那是 Bot 自己的事件）
    app.add_handler(
        ChatMemberHandler(_on_chat_member_update, ChatMemberHandler.CHAT_MEMBER),
        group=50,
    )
    # 群组里任何消息都顺手写一条花名册（group=50 避开 0/99 的主链路）
    app.add_handler(
        MessageHandler(
            (filters.ChatType.GROUP | filters.ChatType.SUPERGROUP) & ~filters.StatusUpdate.ALL,
            _on_group_message,
        ),
        group=50,
    )
    logger.info("Telegram 群组花名册被动收集已注册")
