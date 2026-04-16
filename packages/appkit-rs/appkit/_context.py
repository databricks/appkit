"""Async context-var wrapper for as_user().

Keeps the context-var set/reset inside a native Python coroutine so the
value propagates correctly across the PyO3-tokio bridge.
"""


async def _as_user_wrapper(_cv, _ctx, _fn):
    _tok = _cv.set(_ctx)
    try:
        return await _fn()
    finally:
        _cv.reset(_tok)
