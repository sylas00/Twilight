"""Telegram 群组成员资格校验服务。

集中处理「检查某个 Telegram 用户是否仍在配置中的群组里」这件事，
供绑定流程与定时任务复用。Bot 未运行 / 没有配置群组时一律放行，
仅在 Bot 报告"不是群成员"或返回明确的 BadRequest 时判定为不在群。

调用方约定：
    ok, missing = await TelegramMembershipService.check_user_in_groups(tg_id)
    - ok=True 表示满足所有必需群组（或不需要校验）
    - missing 是结构化数组，方便给到 Bot/前端做友好提示
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union

from src.config import TelegramConfig
from src.services.telegram_runtime import has_telegram_api_access, run_bot_operation

logger = logging.getLogger(__name__)


@dataclass
class MissingGroup:
    id: str
    title: Optional[str] = None
    url: Optional[str] = None

    def to_dict(self) -> dict:
        return {"id": self.id, "title": self.title, "url": self.url}


def _normalize_group_ids() -> List[Union[int, str]]:
    raw = TelegramConfig.GROUP_ID
    if not raw:
        return []
    if isinstance(raw, (int, str)):
        return [raw]
    if isinstance(raw, list):
        return [g for g in raw if g not in (None, "")]
    return []


def _build_invite_url(group_id: Union[int, str], chat) -> Optional[str]:
    """根据群组 ID/Chat 返回可点击的链接（仅公开群可生成 t.me 链接）。"""
    if chat is not None:
        username = getattr(chat, "username", None)
        if username:
            return f"https://t.me/{username}"
    sid = str(group_id).strip()
    if sid.startswith("@"):
        return f"https://t.me/{sid[1:]}"
    return None


class TelegramMembershipService:
    """检查/枚举 Telegram 群组成员资格。"""

    @staticmethod
    def required_group_ids() -> List[Union[int, str]]:
        return _normalize_group_ids()

    @staticmethod
    def enforcement_enabled() -> bool:
        """`TelegramConfig.REQUIRE_GROUP_MEMBERSHIP` 开启 + 至少配置了一个群组时返回 True。"""
        return bool(getattr(TelegramConfig, "REQUIRE_GROUP_MEMBERSHIP", False)) and bool(_normalize_group_ids())

    @staticmethod
    def is_bot_available() -> bool:
        """当前配置是否允许执行 Telegram 成员资格校验。"""
        return has_telegram_api_access()

    @staticmethod
    async def check_user_in_groups(
        telegram_id: int,
        *,
        strict: bool = True,
        sync_roster: bool = False,
    ) -> Tuple[bool, List[MissingGroup]]:
        """检查 Telegram 用户是否在全部必需群组内。

        :param telegram_id: 待检查的用户 ID。
        :param strict: True 时网络异常/Bot 异常视为「不在群」（拦截更紧）；
                       False 时网络异常视为「未知」放行（定时任务建议 False 避免误封）。
        :param sync_roster: True 时把每次探测到的成员状态顺手同步进花名册
                            （在群 → upsert，离群/被踢 → mark_left）。/bind 等
                            主动入口适合开启，定时任务保持默认 False 即可。
        :return: ``(ok, missing_groups)`` —— ``ok`` 为 True 表示通过；
                 ``missing_groups`` 是用户未加入的群组明细。
        """
        if not telegram_id:
            return False, []

        result = await TelegramMembershipService.check_users_in_groups(
            [telegram_id],
            strict=strict,
            sync_roster=sync_roster,
        )
        missing = result.get(int(telegram_id), [])
        return (len(missing) == 0), missing

    @staticmethod
    async def check_users_in_groups(
        telegram_ids: List[int],
        *,
        strict: bool = False,
        sync_roster: bool = False,
    ) -> Dict[int, List[MissingGroup]]:
        """按系统内已绑定用户的 telegram_id 列表批量校验成员资格。

        注意：这里的策略是“以系统用户为基准逐个校验”，
        不依赖也不扫描 Telegram 群的全量成员列表。
        """
        group_ids = _normalize_group_ids()
        normalized_ids: List[int] = []
        seen: set[int] = set()
        for tg_id in telegram_ids:
            try:
                parsed = int(tg_id)
            except (TypeError, ValueError):
                continue
            if parsed <= 0 or parsed in seen:
                continue
            seen.add(parsed)
            normalized_ids.append(parsed)

        if not group_ids or not normalized_ids:
            return {tg_id: [] for tg_id in normalized_ids}

        if not has_telegram_api_access():
            logger.info("Telegram API 不可用，跳过群组成员资格检查")
            if strict:
                fallback = [MissingGroup(id=str(gid)) for gid in group_ids]
                return {tg_id: list(fallback) for tg_id in normalized_ids}
            return {tg_id: [] for tg_id in normalized_ids}

        # 延迟导入 telegram.error，避免顶层依赖
        try:
            from telegram.error import BadRequest, TelegramError, Forbidden
        except Exception:
            BadRequest = TelegramError = Forbidden = Exception  # type: ignore

        async def _check_with_bot(bot) -> Dict[int, List[MissingGroup]]:
            result: Dict[int, List[MissingGroup]] = {tg_id: [] for tg_id in normalized_ids}

            group_meta: Dict[str, object] = {}
            for gid in group_ids:
                chat = None
                try:
                    chat = await bot.get_chat(gid)
                except Exception:
                    chat = None
                group_meta[str(gid)] = chat

            roster_writer = None
            if sync_roster:
                try:
                    from src.db.telegram_roster import TelegramRosterOperate as _Roster

                    roster_writer = _Roster
                except Exception as exc:  # pragma: no cover - import safety
                    logger.warning(f"加载 TelegramRosterOperate 失败，跳过花名册同步: {exc}")
                    roster_writer = None

            semaphore = asyncio.Semaphore(24)

            async def _probe_one(tg_id: int, gid: Union[int, str]) -> Optional[MissingGroup]:
                chat = group_meta.get(str(gid))
                async with semaphore:
                    try:
                        member = await bot.get_chat_member(gid, tg_id)
                        status = str(getattr(member, "status", "") or "").lower()
                        is_bot = bool(getattr(getattr(member, "user", None), "is_bot", False))
                        if status in ("left", "kicked"):
                            if roster_writer is not None:
                                try:
                                    await roster_writer.mark_left(gid, tg_id, status=status)
                                except Exception as exc:  # pragma: no cover
                                    logger.debug(f"花名册 mark_left 失败 (chat={gid}, tg={tg_id}): {exc}")
                            return MissingGroup(
                                id=str(gid),
                                title=getattr(chat, "title", None) if chat else None,
                                url=_build_invite_url(gid, chat),
                            )
                        if roster_writer is not None:
                            try:
                                await roster_writer.upsert_member(
                                    gid,
                                    tg_id,
                                    status=status or "member",
                                    is_bot=is_bot,
                                )
                            except Exception as exc:  # pragma: no cover
                                logger.debug(f"花名册 upsert 失败 (chat={gid}, tg={tg_id}): {exc}")
                        return None
                    except BadRequest as exc:
                        msg = str(exc).lower()
                        if (
                            "not found" in msg
                            or "user not found" in msg
                            or "participant" in msg
                            or "member list is inaccessible" in msg
                        ):
                            return MissingGroup(
                                id=str(gid),
                                title=getattr(chat, "title", None) if chat else None,
                                url=_build_invite_url(gid, chat),
                            )
                        logger.warning(f"检查群组 {gid} 成员资格 BadRequest (tg_id={tg_id}): {exc}")
                        if strict:
                            return MissingGroup(
                                id=str(gid),
                                title=getattr(chat, "title", None) if chat else None,
                                url=_build_invite_url(gid, chat),
                            )
                        return None
                    except Forbidden as exc:
                        logger.warning(f"Bot 缺少群 {gid} 的查看权限 (tg_id={tg_id}): {exc}")
                        # 非严格巡检不因 Bot 失权误封；严格调用方需要把未知视为不通过。
                        if strict:
                            return MissingGroup(
                                id=str(gid),
                                title=getattr(chat, "title", None) if chat else None,
                                url=_build_invite_url(gid, chat),
                            )
                        return None
                    except TelegramError as exc:
                        logger.warning(f"检查群组 {gid} Telegram 异常 (tg_id={tg_id}): {exc}")
                        if strict:
                            return MissingGroup(
                                id=str(gid),
                                title=getattr(chat, "title", None) if chat else None,
                                url=_build_invite_url(gid, chat),
                            )
                        return None
                    except Exception as exc:  # pragma: no cover - safety net
                        logger.warning(f"检查群组 {gid} 未知异常 (tg_id={tg_id}): {exc}")
                        if strict:
                            return MissingGroup(
                                id=str(gid),
                                title=getattr(chat, "title", None) if chat else None,
                                url=_build_invite_url(gid, chat),
                            )
                        return None

            tasks = []
            index: List[Tuple[int, Union[int, str]]] = []
            for tg_id in normalized_ids:
                for gid in group_ids:
                    tasks.append(_probe_one(tg_id, gid))
                    index.append((tg_id, gid))

            probe_results = await asyncio.gather(*tasks)
            for i, missing in enumerate(probe_results):
                if missing is None:
                    continue
                tg_id, _gid = index[i]
                result[tg_id].append(missing)

            return result

        try:
            return await run_bot_operation(_check_with_bot, timeout=60)
        except Exception as exc:
            logger.warning(f"批量执行群组成员资格检查失败: {exc}")
            if strict:
                fallback = [MissingGroup(id=str(gid)) for gid in group_ids]
                return {tg_id: list(fallback) for tg_id in normalized_ids}
            return {tg_id: [] for tg_id in normalized_ids}

    @staticmethod
    def format_missing_message(missing: List[MissingGroup]) -> str:
        if not missing:
            return ""
        lines = ["请先加入以下群组后再绑定 Telegram："]
        for g in missing:
            label = g.title or g.id
            if g.url:
                lines.append(f"• {label} ({g.url})")
            else:
                lines.append(f"• {label}")
        return "\n".join(lines)

    @staticmethod
    async def build_unbound_kick_plan(chat_id: Union[int, str]) -> Dict[str, object]:
        """按 Sakura_EmbyBoss 思路构建群里"该被踢"的 TG ID 计划。

        以群组花名册（Bot 被动观察）为基准，逐个反查 ``users`` 表：

        - 不在 ``users`` 表 / 角色为 UNRECOGNIZED → ``no_account``，踢
        - 角色为 ADMIN/WHITE_LIST → 保留并加入排除集
        - ACTIVE_STATUS=False → ``disabled``，踢
        - EMBYID 为空（含 PENDING_EMBY=True 的待激活） → ``no_emby``，踢
        - 已绑 Emby 且账号有效 → 保留并加入排除集

        Bot 自身、群管理员、TelegramConfig.ADMIN_ID 也会被加进 ``excluded_ids``。
        返回结构：
            {
                'chat_id': str,
                'roster_size': int,
                'bots_in_roster': int,
                'targets': list[int],             # 候选 TG ID（去掉了 bot/管理员）
                'excluded_ids': set[int],
                'reasons': dict[int, str],        # tg_id → kick 原因 ('no_account'|'no_emby'|'disabled')
                'preserved_bound': int,           # 系统内活跃且绑了 Emby 的人数
                'group_admin_ids': set[int],
            }
        """
        from sqlalchemy import select as _select
        from src.config import TelegramConfig
        from src.db.telegram_roster import TelegramRosterOperate
        from src.db.user import (
            Role,
            UserModel,
            UsersSessionFactory,
        )

        plan: Dict[str, object] = {
            "chat_id": str(chat_id),
            "roster_size": 0,
            "bots_in_roster": 0,
            "targets": [],
            "excluded_ids": set(),
            "reasons": {},
            "preserved_bound": 0,
            "group_admin_ids": set(),
        }

        roster_rows = await TelegramRosterOperate.list_active_telegram_ids(chat_id)
        plan["roster_size"] = len(roster_rows)
        roster_human_ids: set[int] = set()
        excluded_ids: set[int] = set()
        for tg_int, is_bot in roster_rows:
            if is_bot:
                plan["bots_in_roster"] = int(plan["bots_in_roster"]) + 1
                excluded_ids.add(tg_int)
                continue
            roster_human_ids.add(tg_int)

        # 一次性反查 users 表
        user_map: Dict[int, UserModel] = {}
        if roster_human_ids:
            async with UsersSessionFactory() as session:
                rows = (
                    (await session.execute(_select(UserModel).where(UserModel.TELEGRAM_ID.in_(list(roster_human_ids)))))
                    .scalars()
                    .all()
                )
                for u in rows:
                    try:
                        user_map[int(u.TELEGRAM_ID)] = u
                    except (TypeError, ValueError):
                        continue

        reasons: Dict[int, str] = {}
        preserved_bound = 0
        for tg_id in roster_human_ids:
            user = user_map.get(tg_id)
            if user is None or user.ROLE == Role.UNRECOGNIZED.value:
                reasons[tg_id] = "no_account"
                continue
            if user.ROLE in (Role.ADMIN.value, Role.WHITE_LIST.value):
                excluded_ids.add(tg_id)
                preserved_bound += 1
                continue
            if not bool(user.ACTIVE_STATUS):
                reasons[tg_id] = "disabled"
                continue
            if not user.EMBYID:
                reasons[tg_id] = "no_emby"
                continue
            # 系统账号正常 + 已绑 Emby → 留人
            excluded_ids.add(tg_id)
            preserved_bound += 1

        # 配置里静态指定的 TG 管理员一并排除（同时从 reasons 里撤销）
        raw_admin = TelegramConfig.ADMIN_ID
        admin_seq = raw_admin if isinstance(raw_admin, (list, tuple)) else [raw_admin]
        for raw in admin_seq:
            try:
                aid = int(raw)
            except (TypeError, ValueError):
                continue
            excluded_ids.add(aid)
            reasons.pop(aid, None)

        # 群管理员/群主
        group_admin_ids = await TelegramMembershipService.fetch_group_admin_ids(chat_id)
        excluded_ids.update(group_admin_ids)
        for aid in group_admin_ids:
            reasons.pop(aid, None)

        targets = sorted(tid for tid in reasons.keys() if tid not in excluded_ids)
        plan["excluded_ids"] = excluded_ids
        plan["group_admin_ids"] = group_admin_ids
        plan["reasons"] = reasons
        plan["preserved_bound"] = preserved_bound
        plan["targets"] = targets
        return plan

    @staticmethod
    async def fetch_group_admin_ids(chat_id: Union[int, str]) -> set[int]:
        """获取群组管理员/群主的 Telegram ID 集合（含 Bot 管理员）。"""
        if not has_telegram_api_access():
            return set()

        async def _fetch(bot) -> set[int]:
            ids: set[int] = set()
            try:
                members = await bot.get_chat_administrators(chat_id)
            except Exception as exc:
                logger.warning(f"获取群 {chat_id} 管理员失败: {exc}")
                return ids
            for m in members or []:
                uid = getattr(getattr(m, "user", None), "id", None)
                if isinstance(uid, int):
                    ids.add(uid)
            return ids

        try:
            return await run_bot_operation(_fetch, timeout=30)
        except Exception as exc:
            logger.warning(f"获取群 {chat_id} 管理员异常: {exc}")
            return set()

    @staticmethod
    async def kick_unknown_members(
        chat_id: Union[int, str],
        candidate_ids: List[int],
        *,
        excluded_ids: set[int],
        max_per_run: int = 200,
    ) -> Dict[str, int | List[dict]]:
        """对 ``candidate_ids`` 中的 TG 用户尝试踢出（先 ban 再 unban）。

        - ``excluded_ids`` 中的 ID 不会被处理（管理员 / 系统已知活跃用户 / Bot 自身）。
        - ``candidate_ids`` 应来自调用方根据"系统内不存在或已删除"的判定。
        - Bot 必须是群管理员，且具有"封禁成员"权限。
        - 踢出策略：``ban`` 后立即 ``unban``（``only_if_banned=True``），等同临时踢出，
          被踢者将来仍可重新加入。
        - 单次最多处理 ``max_per_run`` 个，避免触发 Telegram 限流。
        """
        result: Dict[str, int | List[dict]] = {
            "scanned": 0,
            "kicked": 0,
            "skipped": 0,
            "failed": 0,
            "not_in_group": 0,
            "details": [],
        }
        if not has_telegram_api_access():
            result["details"].append({"reason": "telegram_unavailable"})
            return result

        seen: set[int] = set()
        targets: List[int] = []
        for raw in candidate_ids:
            try:
                tg_id = int(raw)
            except (TypeError, ValueError):
                continue
            if tg_id <= 0 or tg_id in seen:
                continue
            seen.add(tg_id)
            if tg_id in excluded_ids:
                continue
            targets.append(tg_id)
            if len(targets) >= max_per_run:
                break

        if not targets:
            return result

        try:
            from telegram.error import BadRequest, Forbidden, TelegramError
        except Exception:
            BadRequest = Forbidden = TelegramError = Exception  # type: ignore

        async def _do(bot) -> Dict[str, int | List[dict]]:
            # 把 Bot 自身 ID 加进排除集合
            try:
                me = await bot.get_me()
                if getattr(me, "id", None):
                    excluded_ids.add(int(me.id))
            except Exception:
                pass

            local_result: Dict[str, int | List[dict]] = {
                "scanned": len(targets),
                "kicked": 0,
                "skipped": 0,
                "failed": 0,
                "not_in_group": 0,
                "details": [],
            }

            sem = asyncio.Semaphore(8)

            async def _one(tg_id: int) -> None:
                if tg_id in excluded_ids:
                    local_result["skipped"] = int(local_result["skipped"]) + 1
                    return
                async with sem:
                    # 先确认 ta 是否真的在群里 + 是否是管理员
                    try:
                        member = await bot.get_chat_member(chat_id, tg_id)
                    except BadRequest:
                        local_result["not_in_group"] = int(local_result["not_in_group"]) + 1
                        return
                    except (Forbidden, TelegramError) as exc:
                        local_result["failed"] = int(local_result["failed"]) + 1
                        local_result["details"].append({"tg_id": tg_id, "error": f"查询成员失败: {exc}"})
                        return

                    status = str(getattr(member, "status", "") or "").lower()
                    if status in ("creator", "administrator"):
                        local_result["skipped"] = int(local_result["skipped"]) + 1
                        return
                    if status in ("left", "kicked"):
                        local_result["not_in_group"] = int(local_result["not_in_group"]) + 1
                        return
                    if getattr(getattr(member, "user", None), "is_bot", False):
                        local_result["skipped"] = int(local_result["skipped"]) + 1
                        return

                    # ban → unban：实现"临时踢出"
                    try:
                        await bot.ban_chat_member(chat_id, tg_id)
                    except (BadRequest, Forbidden, TelegramError) as exc:
                        local_result["failed"] = int(local_result["failed"]) + 1
                        local_result["details"].append({"tg_id": tg_id, "error": f"踢出失败: {exc}"})
                        return
                    try:
                        await bot.unban_chat_member(chat_id, tg_id, only_if_banned=True)
                    except Exception as exc:
                        logger.debug(f"unban {tg_id} 异常（已踢出）: {exc}")

                    local_result["kicked"] = int(local_result["kicked"]) + 1

            await asyncio.gather(*(_one(tid) for tid in targets))
            return local_result

        try:
            return await run_bot_operation(_do, timeout=120)
        except Exception as exc:
            logger.warning(f"批量踢出非系统成员异常 (chat={chat_id}): {exc}")
            result["failed"] = int(result["failed"]) + 1
            result["details"].append({"error": str(exc)})
            return result

    @staticmethod
    async def ban_user_permanently(
        telegram_id: int,
        *,
        reason: str = "leave_required_group",
    ) -> Dict[str, object]:
        """在所有配置的 ``GROUP_ID`` 群里永久封禁该 TG 用户。

        与 ``kick_unknown_members`` 的"ban + unban"不同，本方法**不调用 unban**，
        因此被封禁用户后续无法重新加入群组。专供"退群完全封禁模式"使用。

        前提条件：Bot 在每个目标群里都是管理员且具备封禁权限。失败的群会在
        ``details`` 中体现，不影响其他群继续封禁。

        :return: ``{"telegram_id", "banned_groups": [str...], "failed_groups": [{"id","error"}...]}``
        """
        out: Dict[str, object] = {
            "telegram_id": int(telegram_id) if telegram_id else 0,
            "banned_groups": [],
            "failed_groups": [],
        }
        try:
            tg_id = int(telegram_id)
        except (TypeError, ValueError):
            return out
        if tg_id <= 0:
            return out

        group_ids = _normalize_group_ids()
        if not group_ids:
            return out

        if not has_telegram_api_access():
            out["failed_groups"] = [{"id": str(g), "error": "telegram_unavailable"} for g in group_ids]
            return out

        try:
            from telegram.error import BadRequest, Forbidden, TelegramError
        except Exception:
            BadRequest = Forbidden = TelegramError = Exception  # type: ignore

        async def _ban_one(bot, gid) -> tuple[str, bool, Optional[str]]:
            try:
                # 不指定 until_date → 永久封禁；revoke_messages=False 避免回删历史消息。
                await bot.ban_chat_member(gid, tg_id, revoke_messages=False)
                return str(gid), True, None
            except BadRequest as exc:
                msg = str(exc).lower()
                # 用户本来就不在群（已退或从未加入）也算成功："封禁名单"已生效
                if "not found" in msg or "participant" in msg or "user not found" in msg:
                    return str(gid), True, None
                return str(gid), False, f"BadRequest: {exc}"
            except Forbidden as exc:
                return str(gid), False, f"Forbidden: {exc}"
            except TelegramError as exc:
                return str(gid), False, f"TelegramError: {exc}"
            except Exception as exc:  # pragma: no cover - safety
                return str(gid), False, f"unexpected: {exc}"

        async def _do(bot) -> Dict[str, object]:
            banned: List[str] = []
            failed: List[dict] = []
            results = await asyncio.gather(*(_ban_one(bot, g) for g in group_ids))
            for gid_str, ok, err in results:
                if ok:
                    banned.append(gid_str)
                else:
                    failed.append({"id": gid_str, "error": err or "unknown"})
            return {
                "telegram_id": tg_id,
                "banned_groups": banned,
                "failed_groups": failed,
            }

        try:
            result = await run_bot_operation(_do, timeout=60)
        except Exception as exc:
            logger.warning(f"永封 TG {tg_id} 异常 (reason={reason}): {exc}")
            out["failed_groups"] = [{"id": str(g), "error": str(exc)} for g in group_ids]
            return out

        if result.get("banned_groups"):
            logger.warning(
                "🚫 TG %d 已被永久封禁于群组 %s (reason=%s)",
                tg_id,
                ", ".join(result["banned_groups"]),
                reason,
            )
        if result.get("failed_groups"):
            logger.warning(
                "永封 TG %d 在部分群失败 (reason=%s): %s",
                tg_id,
                reason,
                result["failed_groups"],
            )
        return result
