"""
=============================================================================
SDAP GeoTIFF Data Retrieval Script (SRS Stage 2/3/4)
=============================================================================
Location: backend/app/db/scripts/retrieve_downloaded_data.py

Description:
    Command-line utility to query downloaded and verified GeoTIFF (.tif)
    rasters from PostgreSQL and NAS storage by State, District, Date Range,
    Satellite, Band, or Composite Interval.
    Supports both Sentinel-1 (VV, VH, VV_VH) and Sentinel-2 (NDVI, LSWI,
    spectral bands) composite deliverables as well as individual scene rasters.
    Supports exporting to CSV, JSON, TXT, or copying files to an output folder.

Usage Examples:
    # 1. Retrieve all deliverables by Request ID:
    python backend/app/db/scripts/retrieve_downloaded_data.py --request-id 34

    # 2. Retrieve composites only for Sentinel-1:
    python backend/app/db/scripts/retrieve_downloaded_data.py --district "Agar Malwa" --satellite Sentinel-1 --composites-only

    # 3. Retrieve Sentinel-2 composites with monthly interval:
    python backend/app/db/scripts/retrieve_downloaded_data.py --district Chittoor --satellite Sentinel-2 --composite-interval monthly

    # 4. Export all matching paths to a text file:
    python backend/app/db/scripts/retrieve_downloaded_data.py --district Chittoor --export-paths paths.txt
=============================================================================
"""

import os
import sys
import json
import csv
import shutil
import argparse
import logging

# Adjust Python path to include backend root directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../../..")))

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
    parser.add_argument("--band", type=str, default=None, help="Spectral or SAR band (B02, B04, B08, B11, SCL, TCI, VV, VH, VV_Composite, VH_Composite, VV_VH_Composite, NDVI_Composite, LSWI_Composite)")
    parser.add_argument("--composite-interval", type=str, default=None, help="Composite interval (weekly, fortnightly, monthly, none)")
    parser.add_argument("--composites-only", action="store_true", help="Retrieve only composite rasters")
    parser.add_argument("--start-date", type=str, default=None, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=str, default=None, help="End date (YYYY-MM-DD)")

    parser.add_argument("--export-csv", type=str, default=None, help="Output CSV filepath")
    parser.add_argument("--export-json", type=str, default=None, help="Output JSON filepath")
    parser.add_argument("--export-paths", type=str, default=None, help="Output TXT filepath with raw file paths")
    parser.add_argument("--copy-to", type=str, default=None, help="Directory to copy retrieved GeoTIFF rasters into")

    args = parser.parse_args()

    db = SessionLocal()
    try:
        if args.request_id and not (args.state or args.district or args.satellite or args.band):
            logger.info(f"Querying downloaded GeoTIFFs for Request #{args.request_id}...")
            result = get_downloaded_tifs_for_request(db, args.request_id)
        else:
            logger.info(
                f"Querying downloaded GeoTIFFs by Region: "
                f"Request={args.request_id or 'None'}, State={args.state or 'Any'}, District={args.district or 'Any'}, "
                f"Satellite={args.satellite or 'Any'}, Band={args.band or 'All'}, "
                f"CompositeInterval={args.composite_interval or 'All'}, "
                f"Dates={args.start_date or 'Earliest'} to {args.end_date or 'Latest'}"
            )
            result = search_downloaded_tifs_by_region(
                db=db,
                state=args.state,
                district=args.district,
                satellite=args.satellite,
                band=args.band,
                start_date=args.start_date,
                end_date=args.end_date,
                composite_interval=args.composite_interval,
                request_id=args.request_id
            )

        total_scenes = result.get("total_scenes", 0)
        total_tifs = result.get("total_tifs", 0)
        total_composites = result.get("total_composites", 0)
        total_mb = result.get("total_size_mb", 0.0)
        tif_paths = result.get("tif_paths", [])
        tifs = result.get("tifs", [])

        if args.composites_only:
            tifs = [t for t in tifs if t.get("is_composite")]
            tif_paths = [t["path"] for t in tifs]
            total_tifs = len(tifs)
            total_mb = round(sum(t.get("size_bytes", 0) for t in tifs) / (1024 * 1024), 2)

        banner = "=" * 78
        print(banner)
        print("SDAP GEOTIFF DATA RETRIEVAL RESULTS")
        print(banner)
        if args.request_id:
            print(f"  • Request ID:        #{args.request_id} ({result.get('request_title') or 'N/A'})")
        print(f"  • Target Region:     State: {result.get('query_state') or result.get('state') or 'N/A'} | District: {result.get('query_district') or result.get('district') or 'N/A'}")
        print(f"  • Matched Tiles:     {result.get('matched_tiles') or 'N/A'}")
        print(f"  • Total Scenes:      {total_scenes} held scenes")
        print(f"  • Total Composites:  {total_composites} composite rasters")
        print(f"  • Total GeoTIFFs:    {total_tifs} .tif files")
        print(f"  • Total Volume:      {total_mb:.1f} MB ({total_mb/1024:.2f} GB)")
        print(banner)

        if not tifs:
            print("  ⚠ No matching verified GeoTIFF rasters found for the given criteria.")
            print(banner)
            return

        print("RETRIEVED GEOTIFF FILE PATHS:")
        print("-" * 78)
        for i, item in enumerate(tifs[:25], start=1):
            sz_mb = item.get("size_bytes", 0) / (1024 * 1024)
            status_str = "EXISTS" if item.get("exists_on_disk") else "MISSING"
            is_comp = item.get("is_composite", False)
            sat_str = item.get("satellite", "Unknown")
            type_tag = f"[COMPOSITE - {sat_str}]" if is_comp else f"[SCENE - {sat_str}]"
            band_str = item.get("band", "N/A")
            print(f"  [{i:02d}] {type_tag:<24} | Band {band_str:<8} | Tile {item.get('tile', 'N/A')} | Date {item.get('sensing_date', 'N/A')} | {sz_mb:6.1f} MB | [{status_str}]")
            print(f"       Path: {item.get('path')}")

        if len(tifs) > 25:
            print(f"  ... and {len(tifs) - 25} more GeoTIFF files.")
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
                fieldnames = ["scene_id", "tile", "sensing_date", "satellite", "band", "is_composite", "size_bytes", "exists_on_disk", "path"]
                writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
                writer.writeheader()
                for item in tifs:
                    writer.writerow(item)
            print(f"  ✓ Exported GeoTIFF manifest to CSV: '{out_c}'")

        if args.copy_to:
            target_dir = os.path.abspath(args.copy_to)
            os.makedirs(target_dir, exist_ok=True)
            copied = 0
            for item in tifs:
                src = item.get("path", "")
                if os.path.exists(src):
                    norm_src = os.path.normpath(src)
                    parts = norm_src.split(os.sep)
                    if "archive" in parts:
                        arch_idx = parts.index("archive")
                        rel_path = os.path.join(*parts[arch_idx + 1:])
                    elif "data" in parts:
                        data_idx = parts.index("data")
                        rel_path = os.path.join(*parts[data_idx + 1:])
                    elif "Composites" in parts:
                        comp_idx = parts.index("Composites")
                        rel_path = os.path.join(*parts[comp_idx:])
                    else:
                        rel_path = f"{item.get('tile', 'Tile')}/{item.get('scene_id', 'Scene')}/{os.path.basename(src)}"
                    dst = os.path.join(target_dir, rel_path)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(src, dst)
                    copied += 1
            print(f"  ✓ Copied {copied} GeoTIFF rasters into target folder: '{target_dir}'")

        print(banner)

    finally:
        db.close()


if __name__ == "__main__":
    main()
