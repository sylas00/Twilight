"""
注册过程同步与缓存工具

为高并发注册场景提供分布式锁和短期缓存支持，防止重复用户名/Telegram 注册、用户数超限。

优化要点：
- 本地锁字典定期清理，防止内存泄漏
- Redis 锁使用 Lua 脚本保证原子性
- 全局注册锁超时缩短，减少死锁窗口
- 锁获取使用指数退避，降低 Redis 压力
"""

import asyncio
import logging
import time
import uuid
from typing import Dict, Optional

from src.config import Config

try:
    from redis.asyncio import Redis
except ImportError:  # pragma: no cover - optional dependency
    Redis = None  # type: ignore

logger = logging.getLogger(__name__)

_redis_client: Optional["Redis"] = None
_local_locks: Dict[str, asyncio.Lock] = {}
# 记录本地锁最后使用时间，用于定期清理
_local_locks_last_used: Dict[str, float] = {}
# 本地锁最大数量和过期时间
_LOCAL_LOCKS_MAX = 10000
_LOCAL_LOCKS_EXPIRE_SECONDS = 120


def _get_redis() -> Optional["Redis"]:
    if not Config.REDIS_URL or Redis is None:
        return None
    global _redis_client
    if _redis_client is None:
        _redis_client = Redis.from_url(
            Config.REDIS_URL,
            decode_responses=True,
            encoding="utf-8",
            socket_connect_timeout=3,
            socket_timeout=5,
            retry_on_timeout=True,
        )
    return _redis_client


def _cleanup_local_locks() -> None:
    """清理过期的本地锁，防止内存无限增长。"""
    now = time.time()
    if len(_local_locks) <= _LOCAL_LOCKS_MAX // 2:
        return

    expired_keys = [
        k for k, last_used in _local_locks_last_used.items()
        if now - last_used > _LOCAL_LOCKS_EXPIRE_SECONDS
        and k in _local_locks
        and not _local_locks[k].locked()
    ]
    for k in expired_keys:
        _local_locks.pop(k, None)
        _local_locks_last_used.pop(k, None)

    # 如果仍然超限，按最后使用时间淘汰未锁定的
    if len(_local_locks) > _LOCAL_LOCKS_MAX:
        unlocked = [
            (k, _local_locks_last_used.get(k, 0))
            for k in _local_locks
            if not _local_locks[k].locked()
        ]
        unlocked.sort(key=lambda x: x[1])
        excess = len(_local_locks) - _LOCAL_LOCKS_MAX
        for k, _ in unlocked[:excess]:
            _local_locks.pop(k, None)
            _local_locks_last_used.pop(k, None)


async def acquire_lock(key: str, timeout: float = 5.0, ttl: int = 30) -> Optional[str]:
    """尝试获取分布式锁，返回锁标识 token。

    Redis 模式下使用指数退避重试，减少高并发时的 Redis 压力。
    本地模式下使用 asyncio.Lock 并记录使用时间。
    """
    redis_client = _get_redis()
    if redis_client is not None:
        token = uuid.uuid4().hex
        deadline = time.time() + timeout
        backoff = 0.05  # 初始退避 50ms
        while time.time() < deadline:
            try:
                if await redis_client.set(key, token, nx=True, ex=ttl):
                    return token
            except Exception as exc:  # pragma: no cover
                logger.warning("Redis 锁获取失败，回退到本地锁：%s", exc)
                break
            await asyncio.sleep(min(backoff, deadline - time.time()))
            backoff = min(backoff * 1.5, 1.0)  # 指数退避，最大 1s
        return None

    # 本地锁模式
    _cleanup_local_locks()

    lock = _local_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _local_locks[key] = lock
    _local_locks_last_used[key] = time.time()

    try:
        await asyncio.wait_for(lock.acquire(), timeout=timeout)
        return key
    except asyncio.TimeoutError:
        return None


async def release_lock(key: str, token: str) -> None:
    """释放分布式锁（Redis 使用 Lua 脚本保证原子性）。"""
    redis_client = _get_redis()
    if redis_client is not None:
        try:
            # Lua 脚本：只有持有者才能释放锁
            script = (
                "if redis.call('get', KEYS[1]) == ARGV[1] then "
                "return redis.call('del', KEYS[1]) else return 0 end"
            )
            await redis_client.eval(script, 1, key, token)
        except Exception as exc:  # pragma: no cover
            logger.warning("Redis 锁释放失败：%s", exc)
        return

    lock = _local_locks.get(key)
    if lock is not None and lock.locked():
        try:
            lock.release()
        except RuntimeError:
            pass


async def acquire_registration_lock(
    username: str,
    telegram_id: Optional[int] = None,
    reg_code: Optional[str] = None,
    timeout: float = 5.0,
    ttl: int = 30,
) -> Optional[Dict[str, str]]:
    """按用户名/Telegram ID/注册码获取注册锁，避免重复注册冲突。

    锁按固定顺序获取（username → telegram → regcode），防止死锁。
    """
    keys = [f"tw:register:username:{username.lower()}"]
    if telegram_id is not None:
        keys.append(f"tw:register:telegram:{telegram_id}")
    if reg_code:
        keys.append(f"tw:register:regcode:{reg_code}")

    acquired: Dict[str, str] = {}
    for key in keys:
        token = await acquire_lock(key, timeout=timeout, ttl=ttl)
        if token is None:
            # 获取失败，释放已获取的锁
            for held_key, held_token in acquired.items():
                await release_lock(held_key, held_token)
            return None
        acquired[key] = token
    return acquired


async def release_registration_lock(locks: Dict[str, str]) -> None:
    for key, token in locks.items():
        await release_lock(key, token)


async def acquire_global_registration_lock(timeout: float = 3.0, ttl: int = 15) -> Optional[str]:
    """获取全局注册锁。

    超时和 TTL 比 per-user 锁更短，减少全局串行化的阻塞窗口。
    如果 3 秒内拿不到全局锁，说明并发压力过大，应该快速失败让客户端重试。
    """
    return await acquire_lock("tw:register:global", timeout=timeout, ttl=ttl)


async def release_global_registration_lock(token: str) -> None:
    await release_lock("tw:register:global", token)


async def get_cached_registered_user_count() -> Optional[int]:
    """获取短期缓存的已注册用户数。"""
    redis_client = _get_redis()
    if redis_client is None:
        return None

    try:
        raw = await redis_client.get("tw:register:count")
        if raw is None:
            return None
        return int(raw)
    except Exception as exc:  # pragma: no cover
        logger.warning("读取注册用户数缓存失败：%s", exc)
        return None


async def set_cached_registered_user_count(count: int, ttl: int = 2) -> None:
    redis_client = _get_redis()
    if redis_client is None:
        return

    try:
        await redis_client.set("tw:register:count", count, ex=ttl)
    except Exception as exc:  # pragma: no cover
        logger.warning("设置注册用户数缓存失败：%s", exc)


async def incr_cached_registered_user_count(delta: int = 1, ttl: int = 2) -> None:
    redis_client = _get_redis()
    if redis_client is None:
        return

    try:
        await redis_client.incrby("tw:register:count", delta)
        await redis_client.expire("tw:register:count", ttl)
    except Exception as exc:  # pragma: no cover
        logger.warning("增加注册数缓存失败：%s", exc)
