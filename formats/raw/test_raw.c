#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "../../core/query/query.h"
#include "../../core/abi/abi.h"
#include "../../core/errors.h"

// -------------------------------
// TEST FLAGS
// -------------------------------
static int FLAG_FAKE = 0;
static int FLAG_VERBOSE = 0;

// -------------------------------
// Fake dataset executor stub
// -------------------------------
static int fake_execute_point(dp_query_t* q, double* out) {
    if (!FLAG_FAKE) return DP_ERR_NOTFOUND;
    *out = 123.45;
    return DP_OK;
}

static int fake_execute_bbox(dp_query_t* q, double* out, int* count) {
    if (!FLAG_FAKE) return DP_ERR_NOTFOUND;
    *count = 4;
    out[0] = 1.0;
    out[1] = 2.0;
    out[2] = 3.0;
    out[3] = 4.0;
    return DP_OK;
}

// -------------------------------
// Arg helpers
// -------------------------------
static void usage(void) {
    printf("Usage:\n");
    printf("  test_raw.exe [options]\n\n");
    printf("Options:\n");
    printf("  --point lon lat                Test POINT query\n");
    printf("  --bbox  minx miny maxx maxy    Test BBOX query\n");
    printf("  --time  ISO_TIME               Test TIME query\n");
    printf("  --fake                         Enable stub dataset\n");
    printf("  --verbose                      Extra prints\n");
    printf("  --help\n");
}

// -------------------------------
// MAIN
// -------------------------------
int main(int argc, char** argv) {
    if (argc == 1) {
        usage();
        return 0;
    }

    dp_query_t q;
    memset(&q, 0, sizeof(q));

    double bbox_vals[4] = {0};
    double point_lon = 0, point_lat = 0;
    char timebuf[64] = {0};

    int have_point = 0;
    int have_bbox = 0;
    int have_time = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--help")) {
            usage();
            return 0;
        }
        else if (!strcmp(argv[i], "--verbose")) {
            FLAG_VERBOSE = 1;
        }
        else if (!strcmp(argv[i], "--fake")) {
            FLAG_FAKE = 1;
        }
        else if (!strcmp(argv[i], "--point")) {
            if (i + 2 >= argc) {
                printf("ERROR: --point requires lon lat\n");
                return -1;
            }
            point_lon = atof(argv[++i]);
            point_lat = atof(argv[++i]);
            have_point = 1;
        }
        else if (!strcmp(argv[i], "--bbox")) {
            if (i + 4 >= argc) {
                printf("ERROR: --bbox requires 4 values\n");
                return -1;
            }
            bbox_vals[0] = atof(argv[++i]);
            bbox_vals[1] = atof(argv[++i]);
            bbox_vals[2] = atof(argv[++i]);
            bbox_vals[3] = atof(argv[++i]);
            have_bbox = 1;
        }
        else if (!strcmp(argv[i], "--time")) {
            if (i + 1 >= argc) {
                printf("ERROR: --time requires value\n");
                return -1;
            }
            strncpy(timebuf, argv[++i], sizeof(timebuf)-1);
            have_time = 1;
        }
        else {
            printf("Unknown flag: %s\n", argv[i]);
            return -1;
        }
    }

    int err = DP_OK;

    // -----------------------------------
    // POINT TEST
    // -----------------------------------
    if (have_point) {
        q.query_type = DP_QUERY_POINT;
        q.lon = point_lon;
        q.lat = point_lat;

        if (FLAG_VERBOSE)
            printf("POINT TEST lon=%.3f lat=%.3f\n", point_lon, point_lat);

        double val = 0.0;
        err = fake_execute_point(&q, &val);

        printf("POINT err=%d found=%d value=%.2f\n",
            err,
            err == DP_OK,
            val
        );
    }

    // -----------------------------------
    // BBOX TEST
    // -----------------------------------
    if (have_bbox) {
        q.query_type = DP_QUERY_BBOX;
        q.lon_min = bbox_vals[0];
        q.lat_min = bbox_vals[1];
        q.lon_max = bbox_vals[2];
        q.lat_max = bbox_vals[3];

        if (FLAG_VERBOSE)
            printf("BBOX TEST %.2f %.2f %.2f %.2f\n",
                bbox_vals[0], bbox_vals[1],
                bbox_vals[2], bbox_vals[3]
            );

        double out[16];
        int count = 0;

        err = fake_execute_bbox(&q, out, &count);

        printf("BBOX err=%d found=%d count=%d\n",
            err,
            err == DP_OK,
            count
        );
    }

    // -----------------------------------
    // TIME TEST (parse only for now)
    // -----------------------------------
    if (have_time) {
        if (FLAG_VERBOSE)
            printf("TIME TEST %s\n", timebuf);

        printf("TIME err=0 parsed=\"%s\"\n", timebuf);
    }

    return 0;
}
