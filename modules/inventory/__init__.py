# inventory package
#
# This package contains the Inventory Management module (RM / PM / FG
# unified). Submodules are imported lazily by app.py — typically via
# `from inventory import inventory_mgmt` and similar — so this file
# stays empty on purpose. Adding `from .helpers import *` or similar
# wildcards here will eagerly load every submodule at app startup and
# can mask real import errors behind cascade failures.
