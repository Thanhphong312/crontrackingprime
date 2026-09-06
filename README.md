# Cron Tracking PrimeHorizon

Electron app — poll ShipEngine tracking + cảnh báo Telegram cho đơn Etsy của PrimeHorizon.

## Yêu cầu
- Node.js >= 18
- Tài khoản ShipEngine (API Key)
- be-tool chạy và có API key `etsy_...`

## Cài đặt

```bash
npm install
npm start
```

## Cấu hình (trong UI Settings)

| Trường | Mô tả |
|---|---|
| API Base URL | URL be-tool, VD: `http://localhost:5102` |
| API Key | API key etsy_... của tài khoản admin/leader |
| ShipEngine API Key | Key ShipEngine |
| Default Carrier | `usps` (mặc định) |

## Hai cron tracking

- **Pre** — đơn fulfilled có tracking nhưng chưa vào transit → poll dày hơn
- **Main** — đơn đã in_transit, chưa delivered → poll thưa hơn

## Alert Telegram

Gửi qua kênh Telegram của store (cấu hình trong be-tool):
- ⚠️ Đơn chưa vào transit sau **48h** từ ngày fulfill
- 🚨 Đơn đã in_transit quá **96h** chưa delivered

Các ngưỡng này cấu hình được trong Settings.

## USPS Tracking Statuses

| Status | Ý nghĩa |
|---|---|
| `pre_shipment` | Chưa scan / carrier vừa nhận |
| `in_transit` | Đang vận chuyển |
| `out_for_delivery` | Đang giao hôm nay |
| `available_for_pickup` | Có thể lấy tại bưu cục |
| `delivered` | Đã giao |
| `alert` | Có sự cố |
| `return_to_sender` | Đang hoàn về |
