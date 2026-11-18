#include <curl/curl.h>
#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_BODY_BYTES (16 * 1024 * 1024)

typedef struct {
    unsigned char *bytes;
    size_t size;
    size_t capacity;
    size_t limit;
} Response;

static size_t append(char *data, size_t size, size_t count, void *context) {
    Response *response = context;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length > response->limit - response->size) return 0;
    size_t required = response->size + length;
    if (required > response->capacity) {
        size_t capacity = response->capacity ? response->capacity * 2 : 65536;
        if (capacity < required) capacity = required;
        if (capacity > response->limit) capacity = response->limit;
        unsigned char *bytes = realloc(response->bytes, capacity);
        if (!bytes) return 0;
        response->bytes = bytes;
        response->capacity = capacity;
    }
    if (length) memcpy(response->bytes + response->size, data, length);
    response->size = required;
    return length;
}

EM_JS(void, reply, (int id, int result, int status, int data, int size, const char *location, int binary), {
    var body = binary ? HEAPU8.slice(data, data + size) : (size ? UTF8ArrayToString(HEAPU8, data, size) : "");
    var response = {
        type: 'kinotix-response', id: id, result: result, status: status,
        body: body,
        location: location ? UTF8ToString(location) : ""
    };
    if (binary) postMessage(response, [body.buffer]);
    else postMessage(response);
});

EMSCRIPTEN_KEEPALIVE
void net_fetch(int id, const char *url, const char *address, const char *method,
               const char *raw_headers, const char *body, int max_bytes, int binary) {
    Response response = {0};
    response.limit = max_bytes > 0 && max_bytes <= MAX_BODY_BYTES ? max_bytes : MAX_BODY_BYTES;
    CURL *curl = curl_easy_init();
    if (!curl) {
        reply(id, CURLE_FAILED_INIT, 0, 0, 0, NULL, binary);
        return;
    }
    struct curl_slist *resolve = NULL;
    struct curl_slist *headers = NULL;
    char *lines = strdup(raw_headers);
    char *line = lines ? strtok(lines, "\n") : NULL;
    int failed = lines == NULL;
    while (line && !failed) {
        struct curl_slist *next = curl_slist_append(headers, line);
        if (!next) failed = 1;
        else headers = next;
        line = strtok(NULL, "\n");
    }
    if (*address) resolve = curl_slist_append(NULL, address);
    if (*address && !resolve) failed = 1;
    if (failed) {
        reply(id, CURLE_OUT_OF_MEMORY, 0, 0, 0, NULL, binary);
    } else {
        curl_easy_setopt(curl, CURLOPT_URL, url);
        curl_easy_setopt(curl, CURLOPT_RESOLVE, resolve);
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
        curl_easy_setopt(curl, CURLOPT_PROXY, "");
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 5500L);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 12000L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(curl, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
        curl_easy_setopt(curl, CURLOPT_CAINFO, "/cacert.pem");
        curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, "");
        curl_easy_setopt(curl, CURLOPT_USERAGENT,
            "Mozilla/5.0 (SMART-TV; LINUX; Tizen 10.0) AppleWebKit/537.36 "
            "(KHTML, like Gecko) 130.0.6723.116/10.0 TV Safari/537.36 KinoTix/0.2");
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, append);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
        if (strcmp(method, "POST") == 0) {
            curl_easy_setopt(curl, CURLOPT_POST, 1L);
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)strlen(body));
        }
        CURLcode result = curl_easy_perform(curl);
        long status = 0;
        char *location = NULL;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
        curl_easy_getinfo(curl, CURLINFO_REDIRECT_URL, &location);
        reply(id, result, (int)status, (int)(uintptr_t)response.bytes, (int)response.size, location, binary);
    }
    curl_slist_free_all(headers);
    curl_slist_free_all(resolve);
    curl_easy_cleanup(curl);
    free(lines);
    free(response.bytes);
}
