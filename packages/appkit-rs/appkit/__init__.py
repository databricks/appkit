from .appkit import *  # noqa: F401,F403
from .appkit import __doc__

if hasattr(__import__("appkit.appkit", fromlist=["__all__"]), "__all__"):
    from .appkit import __all__
