"""
=============================================================================
SDAP GeoTIFF Data Retrieval Script (SRS Stage 2/3/4)
=============================================================================
Location: backend/scripts/retrieve_downloaded_data.py

Description:
    Command-line utility to query downloaded and verified GeoTIFF (.tif)
    rasters from PostgreSQL by State, District, Date Range, Satellite, or Band.
    Matches spatial tile mappings, extracts DB file paths, prints path summaries,
    and supports exporting to CSV, JSON, TXT, or copying files to an output folder.

Usage Examples:
    # 1. Retrieve by Request ID:
    python scripts/retrieve_downloaded_data.py --request-id 18

    # 2. Retrieve by State & District:
    python scripts/retrieve_downloaded_data.py --state Telangana --district Khammam

    # 3. Retrieve specific band (B04) for a date window and export to CSV:
    python scripts/retrieve_downloaded_data.py --district Khammam --band B04 --export-csv khammam_b04.csv

    # 4. Export all matching paths to a text file for GDAL/Python processing:
    python scripts/retrieve_downloaded_data.py --district Khammam --export-paths paths.txt
=============================================================================
"""

import os
import sys
import json
import csv
import shutil
import argparse
import logging
from datetime import datetime

# Adjust Python path to include backend root directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import SessionLocal
from app.services.downloader_service import (
    get_downloaded_tifs_for_request,
    search_downloaded_tifs_by_region
)

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger("sdap.retrieve_script")


def main():
    parser = argparse.ArgumentParser(description="SDAP Downloaded Data Retrieval Utility")
    parser.add_argument("--request-id", type=int, default=None, help="Filter by Request ID")
    parser.add_argument("--state", type=str, default=None, help="State name (e.g. Telangana, Odisha)")
    parser.add_argument("--district", type=str, default=None, help="District name (e.g. Khammam, Cuttack)")
    parser.add_argument("--satellite", type=str, default=None, help="Satellite sensor (Sentinel-1, Sentinel-2)")
    parser.add_argument("--band", type=str, default=None, help="Spectral or SAR band (B02, B04, B08, B11, SCL, TCI, VV, VH)")
    parser.add_argument("--start-date", type=str, default=None, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=str, default=None, help="End date (YYYY-MM-DD)")

    parser.add_argument("--export-csv", type=str, default=None, help="Output CSV filepath")
    parser.add_argument("--export-json", type=str, default=None, help="Output JSON filepath")
    parser.add_argument("--export-paths", type=str, default=None, help="Output TXT filepath with raw file paths")
    parser.add_argument("--copy-to", type=str, default=None, help="Directory to copy retrieved GeoTIFF rasters into")

    args = parser.parse_args()

    db = SessionLocal()
    try:
        if args.request_id:
            logger.info(f"Querying downloaded GeoTIFFs for Request #{args.request_id}...")
            result = get_downloaded_tifs_for_request(db, args.request_id)
        else:
            logger.info(
                f"Querying downloaded GeoTIFFs by Region: "
                f"State={args.state or 'Any'}, District={args.district or 'Any'}, "
                f"Satellite={args.satellite or 'Any'}, Band={args.band or 'All'}, "
                f"Dates={args.start_date or 'Earliest'} to {args.end_date or 'Latest'}"
            )
            result = search_downloaded_tifs_by_region(
                db=db,
                state=args.state,
                district=args.district,
                satellite=args.satellite,
                band=args.band,
                start_date=args.start_date,
                end_date=args.end_date
            )

        total_scenes = result.get("total_scenes", 0)
        total_tifs = result.get("total_tifs", 0)
        total_mb = result.get("total_size_mb", 0.0)
        tif_paths = result.get("tif_paths", [])
        tifs = result.get("tifs", [])

        banner = "=" * 78
        print(banner)
        print(f"SDAP GEOTIFF DATA RETRIEVAL RESULTS")
        print(banner)
        if args.request_id:
            print(f"  • Request ID:      #{args.request_id} ({result.get('request_title')})")
        print(f"  • Target Region:   State: {result.get('query_state') or result.get('state') or 'N/A'} | District: {result.get('query_district') or result.get('district') or 'N/A'}")
        print(f"  • Matched Tiles:   {result.get('matched_tiles') or 'N/A'}")
        print(f"  • Total Scenes:    {total_scenes} held scenes")
        print(f"  • Total GeoTIFFs:  {total_tifs} .tif files")
        print(f"  • Total Volume:    {total_mb:.1f} MB ({total_mb/1024:.2f} GB)")
        print(banner)

        if not tifs:
            print("  ⚠ No matching verified GeoTIFF rasters found for the given criteria.")
            print(banner)
            return

        print("RETRIEVED GEOTIFF FILE PATHS:")
        print("-" * 78)
        for i, item in enumerate(tifs[:15], start=1):
            sz_mb = item["size_bytes"] / (1024 * 1024)
            status_str = "EXISTS" if item["exists_on_disk"] else "MISSING ON DISK"
            print(f"  [{i:02d}] Band {item['band']:<8} | Tile {item['tile']} | Date {item['sensing_date']} | {sz_mb:6.1f} MB | [{status_str}]")
            print(f"       Path: {item['path']}")

        if len(tifs) > 15:
            print(f"  ... and {len(tifs) - 15} more GeoTIFF files.")
        print("-" * 78)

        # Export Options
        if args.export_paths:
            out_p = os.path.abspath(args.export_paths)
            with open(out_p, "w", encoding="utf-8") as f:
                for p in tif_paths:
                    f.write(p + "\n")
            print(f"  ✓ Exported {len(tif_paths)} raw file paths to: '{out_p}'")

        if args.export_json:
            out_j = os.path.abspath(args.export_json)
            with open(out_j, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2)
            print(f"  ✓ Exported retrieval metadata to JSON: '{out_j}'")

        if args.export_csv:
            out_c = os.path.abspath(args.export_csv)
            with open(out_c, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=["scene_id", "tile", "sensing_date", "satellite", "band", "size_bytes", "exists_on_disk", "path"])
                writer.writeheader()
                for item in tifs:
                    writer.writerow(item)
            print(f"  ✓ Exported GeoTIFF manifest to CSV: '{out_c}'")

        if args.copy_to:
            target_dir = os.path.abspath(args.copy_to)
            os.makedirs(target_dir, exist_ok=True)
            copied = 0
            for item in tifs:
                src = item["path"]
                if os.path.exists(src):
                    norm_src = os.path.normpath(src)
                    parts = norm_src.split(os.sep)
                    if "archive" in parts:
                        arch_idx = parts.index("archive")
                        rel_path = os.path.join(*parts[arch_idx + 1:])
                    elif "data" in parts:
                        data_idx = parts.index("data")
                        rel_path = os.path.join(*parts[data_idx + 1:])
                    else:
                        rel_path = f"{item['tile']}/{item['scene_id']}/{item['band']}.tif"
                    dst = os.path.join(target_dir, rel_path)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(src, dst)
                    copied += 1
            print(f"  ✓ Copied {copied} GeoTIFF rasters into target folder preserving directory structure: '{target_dir}'")

        print(banner)

    finally:
        db.close()


if __name__ == "__main__":
    main()

