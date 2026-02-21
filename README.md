# ProxyDNS (Node.js, no proxy library)

HTTP/HTTPS forward proxy thuần Node.js để client/container dùng proxy thay cho DNS local bị lỗi.

## Chạy nhanh

```bash
node proxy.js
```

Proxy mặc định lắng nghe `0.0.0.0:3128`.

## Environment variables

- `PROXY_HOST`: địa chỉ bind (mặc định `0.0.0.0`)
- `PROXY_PORT`: cổng bind (mặc định `3128`)
- `REQUEST_TIMEOUT_MS`: timeout cho HTTP request thường (mặc định `30000`)
- `CONNECT_TIMEOUT_MS`: timeout cho HTTPS tunnel `CONNECT` (mặc định `20000`)
- `ALLOW_CONNECT_PORTS`: whitelist port cho `CONNECT` (ví dụ `443,8443`)
- `HOST_MAP`: map domain -> IP, phân tách bằng dấu phẩy  
  Ví dụ: `google.com=142.250.72.14,api.example.com=1.2.3.4`
- `DNS_SERVERS`: ép proxy dùng DNS server chỉ định  
  Ví dụ: `1.1.1.1,8.8.8.8`

## Dùng từ container bị lỗi DNS

Trong container cần truy cập internet:

```bash
export HTTP_PROXY=http://<PROXY_IP>:3128
export HTTPS_PROXY=http://<PROXY_IP>:3128
export NO_PROXY=localhost,127.0.0.1
```

Ví dụ test:

```bash
curl -I https://example.com
```

Nếu DNS trong container hỏng, request vẫn đi được vì proxy (server này) là bên resolve domain.
