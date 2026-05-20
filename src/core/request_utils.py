"""
请求工具模块

提供从反向代理后正确提取客户端 IP 等请求相关工具函数。
"""

import ipaddress
from flask import request

# 可信代理网段：仅当 remote_addr 属于这些网段时才信任 X-Forwarded-For / X-Real-IP
_TRUSTED_PROXIES = {
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
}


def _is_trusted_proxy(ip_str: str) -> bool:
    """判断 IP 是否属于可信代理网段。"""
    try:
        addr = ipaddress.ip_address(ip_str)
        return any(addr in net for net in _TRUSTED_PROXIES)
    except (ValueError, TypeError):
        return False


def get_real_client_ip() -> str:
    """从请求中提取真实客户端 IP。

    策略：
    1. 如果 remote_addr 是可信代理，依次检查 X-Real-IP 和 X-Forwarded-For
    2. X-Forwarded-For 取最右侧的非可信代理 IP（防止客户端伪造左侧 IP）
    3. 都不可用时回退到 remote_addr

    生产环境部署在 Nginx/Caddy 后面时，request.remote_addr 通常是 127.0.0.1，
    必须从代理头中提取真实 IP，否则所有用户共享同一个限流桶。
    """
    remote_addr = request.remote_addr or "unknown"

    if not _is_trusted_proxy(remote_addr):
        return remote_addr

    # 优先使用 X-Real-IP（Nginx 通常设置此头）
    x_real_ip = request.headers.get("X-Real-IP", "").strip()
    if x_real_ip:
        try:
            ipaddress.ip_address(x_real_ip)
            return x_real_ip
        except ValueError:
            pass

    # 回退到 X-Forwarded-For：从右向左找第一个非可信代理 IP
    x_forwarded_for = request.headers.get("X-Forwarded-For", "").strip()
    if x_forwarded_for:
        ips = [ip.strip() for ip in x_forwarded_for.split(",") if ip.strip()]
        # 从右向左遍历，跳过可信代理
        for ip in reversed(ips):
            try:
                ipaddress.ip_address(ip)
                if not _is_trusted_proxy(ip):
                    return ip
            except ValueError:
                continue
        # 所有 IP 都是可信代理，取最左侧（最外层客户端）
        if ips:
            return ips[0]

    return remote_addr
