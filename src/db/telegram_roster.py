"""Telegram 群组花名册数据库模块。

Bot API 没有 ``getChatMembers``，没法主动枚举群组成员；这里通过被动观察
（``chat_member`` 更新事件 + 消息作者）把见过的 TG 用户写进本地表，方便
后续做"踢出未绑 Web 账号的群成员"这类批量操作。

字段说明：
    - CHAT_ID: 群组 ID（字符串：兼容 -100xxxx 数字与 @username）
    - TELEGRAM_ID: 用户 TG ID
    - IS_BOT: 是否为 Bot（这些不会被批量踢）
    - LAST_STATUS: 最后已知状态（member/administrator/creator/left/kicked/restricted）
    - FIRST_SEEN_AT / LAST_SEEN_AT: 首次/最后一次被观察到的时间戳
"""
from __future__ import annotations

import time
from typing import List, Optional, Tuple

from sqlalchemy import (
    Boolean, Integer, String, UniqueConstraint, delete, func, select, update,
)
from sqlalchemy.ext.asyncio import AsyncAttrs, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from src.config import Config
from src.db.utils import create_database


class TelegramRosterDatabaseModel(AsyncAttrs, DeclarativeBase):
    pass


# 已知 / 已退出群的状态枚举（只是字符串约定，不强枚举类型）
ACTIVE_STATUSES = {"member", "administrator", "creator", "restricted"}
INACTIVE_STATUSES = {"left", "kicked"}


class TelegramGroupRosterModel(TelegramRosterDatabaseModel):
    """Bot 观察到的群组成员（按 chat_id+telegram_id 唯一）。"""
    __tablename__ = "telegram_group_roster"

    ID: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    CHAT_ID: Mapped[str] = mapped_column(String, index=True, nullable=False)
    TELEGRAM_ID: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    IS_BOT: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    LAST_STATUS: Mapped[Optional[str]] = mapped_column(String, default="member", nullable=True)
    FIRST_SEEN_AT: Mapped[int] = mapped_column(Integer, nullable=False)
    LAST_SEEN_AT: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        UniqueConstraint("CHAT_ID", "TELEGRAM_ID", name="uq_chat_user"),
    )


create_database("telegram_roster", TelegramRosterDatabaseModel)
DATABASE_URL = f'sqlite+aiosqlite:///{Config.DATABASES_DIR / "telegram_roster.db"}'
ENGINE = create_async_engine(DATABASE_URL, echo=Config.SQLALCHEMY_LOG)
TelegramRosterSessionFactory = async_sessionmaker(bind=ENGINE, expire_on_commit=False)


def _now() -> int:
    return int(time.time())


def _chat_key(chat_id) -> str:
    """统一 chat_id 字符串化：兼容数字 ID 与 @username。"""
    if chat_id is None:
        return ""
    return str(chat_id).strip()


class TelegramRosterOperate:
    """群组花名册 CRUD。"""

    @staticmethod
    async def upsert_member(
        chat_id,
        telegram_id: int,
        *,
        status: Optional[str] = None,
        is_bot: bool = False,
    ) -> None:
        """记一条「在群」证据：插入或刷新 ``last_seen_at`` / ``last_status``。"""
        chat_key = _chat_key(chat_id)
        try:
            tg_id = int(telegram_id)
        except (TypeError, ValueError):
            return
        if not chat_key or tg_id <= 0:
            return

        now = _now()
        async with TelegramRosterSessionFactory() as session:
            async with session.begin():
                existing = await session.execute(
                    select(TelegramGroupRosterModel).where(
                        TelegramGroupRosterModel.CHAT_ID == chat_key,
                        TelegramGroupRosterModel.TELEGRAM_ID == tg_id,
                    )
                )
                row = existing.scalar_one_or_none()
                if row:
                    row.LAST_SEEN_AT = now
                    if status:
                        row.LAST_STATUS = status
                    if is_bot:
                        row.IS_BOT = True
                else:
                    session.add(TelegramGroupRosterModel(
                        CHAT_ID=chat_key,
                        TELEGRAM_ID=tg_id,
                        IS_BOT=bool(is_bot),
                        LAST_STATUS=status or "member",
                        FIRST_SEEN_AT=now,
                        LAST_SEEN_AT=now,
                    ))

    @staticmethod
    async def mark_left(chat_id, telegram_id: int, status: str = "left") -> None:
        """把成员标记为「已离开」状态；记录保留以便去重统计。"""
        chat_key = _chat_key(chat_id)
        try:
            tg_id = int(telegram_id)
        except (TypeError, ValueError):
            return
        if not chat_key or tg_id <= 0:
            return

        async with TelegramRosterSessionFactory() as session:
            async with session.begin():
                await session.execute(
                    update(TelegramGroupRosterModel)
                    .where(
                        TelegramGroupRosterModel.CHAT_ID == chat_key,
                        TelegramGroupRosterModel.TELEGRAM_ID == tg_id,
                    )
                    .values(LAST_STATUS=status, LAST_SEEN_AT=_now())
                )

    @staticmethod
    async def list_active_telegram_ids(chat_id) -> List[Tuple[int, bool]]:
        """返回该群里"最后已知状态仍视为在群"的 ``(tg_id, is_bot)`` 列表。"""
        chat_key = _chat_key(chat_id)
        if not chat_key:
            return []
        async with TelegramRosterSessionFactory() as session:
            rows = (await session.execute(
                select(TelegramGroupRosterModel.TELEGRAM_ID, TelegramGroupRosterModel.IS_BOT)
                .where(
                    TelegramGroupRosterModel.CHAT_ID == chat_key,
                    TelegramGroupRosterModel.LAST_STATUS.in_(list(ACTIVE_STATUSES)),
                )
            )).all()
        return [(int(tg_id), bool(is_bot)) for tg_id, is_bot in rows]

    @staticmethod
    async def count_active(chat_id) -> int:
        chat_key = _chat_key(chat_id)
        if not chat_key:
            return 0
        async with TelegramRosterSessionFactory() as session:
            scalar = await session.execute(
                select(func.count())
                .select_from(TelegramGroupRosterModel)
                .where(
                    TelegramGroupRosterModel.CHAT_ID == chat_key,
                    TelegramGroupRosterModel.LAST_STATUS.in_(list(ACTIVE_STATUSES)),
                )
            )
            return int(scalar.scalar_one() or 0)

    @staticmethod
    async def stats(chat_id) -> dict:
        """返回某 chat 的花名册统计 (active / inactive / bots / first_seen / last_seen)。"""
        chat_key = _chat_key(chat_id)
        result = {
            "chat_id": chat_key,
            "active": 0,
            "inactive": 0,
            "bots": 0,
            "first_seen_at": None,
            "last_seen_at": None,
        }
        if not chat_key:
            return result
        async with TelegramRosterSessionFactory() as session:
            agg = await session.execute(
                select(
                    func.count(),
                    func.min(TelegramGroupRosterModel.FIRST_SEEN_AT),
                    func.max(TelegramGroupRosterModel.LAST_SEEN_AT),
                )
                .where(TelegramGroupRosterModel.CHAT_ID == chat_key)
            )
            total, first_seen, last_seen = agg.one()
            result["first_seen_at"] = int(first_seen) if first_seen else None
            result["last_seen_at"] = int(last_seen) if last_seen else None

            active_q = await session.execute(
                select(func.count())
                .select_from(TelegramGroupRosterModel)
                .where(
                    TelegramGroupRosterModel.CHAT_ID == chat_key,
                    TelegramGroupRosterModel.LAST_STATUS.in_(list(ACTIVE_STATUSES)),
                )
            )
            result["active"] = int(active_q.scalar_one() or 0)

            bots_q = await session.execute(
                select(func.count())
                .select_from(TelegramGroupRosterModel)
                .where(
                    TelegramGroupRosterModel.CHAT_ID == chat_key,
                    TelegramGroupRosterModel.IS_BOT == True,
                )
            )
            result["bots"] = int(bots_q.scalar_one() or 0)

            result["inactive"] = max(0, int(total or 0) - result["active"])
        return result

    @staticmethod
    async def purge_old_inactive(older_than_seconds: int = 60 * 24 * 3600) -> int:
        """清理超过 N 秒没再被观察到、且最后状态为 left/kicked 的记录。"""
        cutoff = _now() - max(3600, int(older_than_seconds))
        async with TelegramRosterSessionFactory() as session:
            async with session.begin():
                result = await session.execute(
                    delete(TelegramGroupRosterModel).where(
                        TelegramGroupRosterModel.LAST_STATUS.in_(list(INACTIVE_STATUSES)),
                        TelegramGroupRosterModel.LAST_SEEN_AT < cutoff,
                    )
                )
                return int(result.rowcount or 0)
