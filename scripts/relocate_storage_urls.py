"""Relocate stored LocalMiniDrama URLs after copying its SQLite database."""

import argparse
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    parser.add_argument("--old-host", required=True)
    parser.add_argument("--new-host", required=True)
    args = parser.parse_args()
    columns = {
        "storyboards": ["video_url"],
        "async_tasks": ["result"],
        "video_generations": ["image_url", "first_frame_url", "last_frame_url", "reference_image_urls", "video_url"],
        "ai_service_configs": ["base_url"],
    }
    with sqlite3.connect(args.database) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        for table, names in columns.items():
            for column in names:
                for old_port, new_port in ((3013, 5679), (5679, 5679), (5688, 5688)):
                    old = f"http://{args.old_host}:{old_port}"
                    new = f"http://{args.new_host}:{new_port}"
                    cursor = db.execute(
                        f'UPDATE "{table}" SET "{column}" = replace("{column}", ?, ?) '
                        f'WHERE instr("{column}", ?) > 0', (old, new, old)
                    )
                    if cursor.rowcount:
                        print(f"{table}.{column}: {cursor.rowcount} URLs relocated")
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


if __name__ == "__main__":
    main()
