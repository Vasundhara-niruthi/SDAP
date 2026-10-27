#!/usr/bin/env python3
"""
=============================================================================
SDAP Sentinel-1 SAR Processing Engine (Remote Sensing Team Pipeline)
=============================================================================
Location: backend/scripts/Sentinel_1_Processing.py

Description:
    Processes raw Sentinel-1 Level-1 GRD products (manifest.safe) using either
    the ESA SNAP GPT engine (grd_to_gee_db.xml) or the calibrated high-precision
    Python SAR radiometric engine.

    Outputs all 3 verified, calibrated negative decibel GeoTIFFs:
      - VV_Orb_tnr_cal_Tc_db.tiff  (Co-pol Sigma0 in dB)
      - VH_Orb_tnr_cal_Tc_db.tiff  (Cross-pol Sigma0 in dB)
      - VV_VH_Orb_tnr_cal_Tc_db.tiff  (Dual-Pol Ratio: VV_dB - VH_dB)
=============================================================================
"""

import os
import sys
import argparse
import subprocess
import logging

# Ensure backend root is on sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from app.services.sentinel1_processor_service import (
    run_sentinel_1_processing,
    compute_s1_vv_vh_ratio,
    get_gpt_path,
    get_xml_graph_path,
    win_safe_path
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.s1_processing")

# CONFIGURATION: Set the local path to your SNAP installation engine
GPT_PATH = r"C:\Program Files\snap\bin\gpt.exe"


def run_db_pipeline(input_path: str, output_path: str, xml_path: str):
    """
    Executes the ESA SNAP GPT pipeline or native high-precision SAR engine
    for the given input_path (manifest.safe or scene folder).
    """
    if not os.path.exists(win_safe_path(input_path)):
        print(f"❌ Error: Input path not found: {input_path}")
        return False

    scene_dir = input_path if os.path.isdir(win_safe_path(input_path)) else os.path.dirname(input_path)
    print("--------------------------------------------------")
    print(f"🚀 Processing Sentinel-1 Scene: {os.path.basename(scene_dir)}")
    print("--------------------------------------------------")

    res = run_sentinel_1_processing(
        scene_dir=scene_dir,
        gpt_path=GPT_PATH if os.path.exists(GPT_PATH) else None,
        xml_path=xml_path,
        log_fn=print
    )

    if res.get("success"):
        print("✅ Success! Output GeoTIFFs successfully generated with exact GEE schema:")
        print(f"   * VV (dB):    {res.get('vv_path')}")
        print(f"   * VH (dB):    {res.get('vh_path')}")
        print(f"   * VV/VH:      {res.get('vv_vh_path')}")
        return True
    else:
        print(f"❌ Pipeline failed: {res.get('error')}")
        return False


def main():
    parser = argparse.ArgumentParser(description="SDAP Sentinel-1 SAR Calibration & Terrain Correction Pipeline")
    parser.add_argument("--scene-dir", type=str, help="Path to Sentinel-1 scene folder")
    parser.add_argument("--input-grd", type=str, help="Path to input manifest.safe")
    parser.add_argument("--output-tiff", type=str, help="Path to output GeoTIFF file")
    parser.add_argument("--xml-graph", type=str, help="Path to grd_to_gee_db.xml")
    parser.add_argument("--gpt-path", type=str, help="Path to SNAP gpt.exe")
    args = parser.parse_args()

    input_p = args.input_grd or args.scene_dir
    if not input_p:
        print("[INFO] No input specified. Usage:")
        print("  python Sentinel_1_Processing.py --input-grd <path_to_manifest.safe>")
        return 0

    xml_p = args.xml_graph or get_xml_graph_path()
    output_p = args.output_tiff or os.path.join(os.path.dirname(input_p), "Anantapur_VH.tif")
    ok = run_db_pipeline(input_p, output_p, xml_p)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
