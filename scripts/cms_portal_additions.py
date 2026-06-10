# ══════════════════════════════════════════════════════════════════════════════
# ADD THESE FUNCTIONS TO cms_portal.py
# ══════════════════════════════════════════════════════════════════════════════


def cms_save_ledger_group(payload):
    """Create a new custom ledger group."""
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO cms_ledger_groups (name, nature, is_system) VALUES (%s, %s, 0)",
            (payload['name'], payload['nature'])
        )
        conn.commit()
        return {'status': 'ok', 'id': cur.lastrowid}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


def cms_delete_ledger_group(gid):
    """Delete a custom (non-system) ledger group. Fails if ledgers are assigned."""
    conn = get_db()
    cur  = conn.cursor()
    try:
        # Block deletion of system groups
        cur.execute("SELECT is_system FROM cms_ledger_groups WHERE id = %s", (gid,))
        row = cur.fetchone()
        if not row:
            return {'status': 'error', 'message': 'Group not found'}
        if row['is_system']:
            return {'status': 'error', 'message': 'Cannot delete system groups'}
        # Block if ledgers are assigned
        cur.execute("SELECT COUNT(*) as c FROM cms_ledgers WHERE ledger_group_id = %s", (gid,))
        if cur.fetchone()['c'] > 0:
            return {'status': 'error', 'message': 'Cannot delete — ledgers are assigned to this group'}
        cur.execute("DELETE FROM cms_ledger_groups WHERE id = %s AND is_system = 0", (gid,))
        conn.commit()
        return {'status': 'ok'}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()
