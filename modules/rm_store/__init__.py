# rm_store package — Production Initiater + Recycle Bin + Access Control
#
# Exposes:
#   - production_initiater_bp : Flask Blueprint registered in app.py
#
# Imported in app.py as:
#   from rm_store.production_initiater_routes import production_initiater_bp
from .production_initiater_routes import production_initiater_bp

__all__ = ['production_initiater_bp']
