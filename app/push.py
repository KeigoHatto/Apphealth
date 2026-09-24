"""Web Push の送信。購読が切れている端末（404 / 410）は購読を削除する。"""

from __future__ import annotations

import json
import logging

import requests
from pywebpush import WebPushException, webpush

from app import config

logger = logging.getLogger("apphealth")

# 端末がオフラインでも、この秒数のうちに繋がれば届く（古いリマインドは届けても意味がない）
TTL_SECONDS = 60 * 60


def is_configured() -> bool:
    return bool(config.VAPID_PUBLIC_KEY and config.VAPID_PRIVATE_KEY)


def send_to_all(conn, payload: dict) -> dict:
    """全端末に送る。{"sent": 成功数, "failed": 失敗数, "removed": 削除した購読数} を返す。"""
    if not is_configured():
        raise RuntimeError("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が設定されていません")
    subs = conn.execute("select endpoint, p256dh, auth from push_subscriptions").fetchall()
    data = json.dumps(payload, ensure_ascii=False)
    counts = {"sent": 0, "failed": 0, "removed": 0}
    for s in subs:
        info = {"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}}
        try:
            webpush(info, data, vapid_private_key=config.VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": config.VAPID_SUBJECT}, ttl=TTL_SECONDS, timeout=10)
            counts["sent"] += 1
        except WebPushException as e:
            status = e.response.status_code if e.response is not None else None
            if status in (404, 410):
                conn.execute("delete from push_subscriptions where endpoint = %s", (s["endpoint"],))
                counts["removed"] += 1
            else:
                logger.warning("push failed (%s): %s", status, e.message)
                counts["failed"] += 1
        except requests.RequestException:
            logger.warning("push failed: %s", s["endpoint"][:60], exc_info=True)
            counts["failed"] += 1
    return counts
