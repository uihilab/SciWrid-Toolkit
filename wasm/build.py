import subprocess, sys, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

EMCC = r"C:\Users\Khoa Le\Downloads\emsdk-main\emsdk-main\upstream\emscripten\emcc.py"

cmd = [
    sys.executable, EMCC,
    "-O2", "-std=c99", "-I..",
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8']",
    "-sEXPORTED_FUNCTIONS=['_wp_scan','_wp_scan_num_vars','_wp_scan_get_vars_json','_wp_scan_free',"
    "'_wp_normalize','_wp_nc3_scan','_wp_nc3_scan_get_vars_json','_wp_nc3_normalize','_wp_nc3_scan_free',"
    "'_wp_open_from_float_arrays',"
    "'_wp_close','_wp_variable_name','_wp_nx','_wp_ny','_wp_nt','_wp_is_timeseries',"
    "'_wp_ds_lats_ptr','_wp_ds_lons_ptr','_wp_ds_times_ptr','_wp_ds_data_ptr',"
    "'_wp_find_nearest_lat','_wp_find_nearest_lon','_wp_query','_wp_free','_wp_malloc','_wp_memcpy',"
    "'_malloc','_free']",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=WebParsers",
    "-sENVIRONMENT=web,worker,node",
    "-sNO_EXIT_RUNTIME=1",
    "-o", "webparsers.js",
    "wasm_api.c",
    r"..\tools\query_refs.c",
    r"..\core\util\base64.c",
    r"..\helper\grib2converthelpers.c",
    r"..\formats\grib2\grib2_metadata.c",
    r"..\formats\netcdf\netcdf3.c",
    "-lm",
]

print("Building...")
result = subprocess.run(cmd)
print("\nBUILD SUCCESS" if result.returncode == 0 else "\nBUILD FAILED")
