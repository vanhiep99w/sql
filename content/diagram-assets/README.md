# Icon assets

Logo công nghệ lấy từ [D2 Icon Catalog](https://icons.d2lang.com/), nhóm `dev` (Devicon). URL chính xác và SHA-256 nằm trong `catalog.json`; SVG đã được kiểm tra không có script, event handler hay tài nguyên từ xa. Giữ giấy phép Devicon MIT tại `LICENSE-devicon`; logo/tên sản phẩm vẫn thuộc chủ sở hữu nhãn hiệu, không hàm ý bảo trợ.

Chỉ dùng cho MySQL/PostgreSQL thật, không gán logo hãng cho database trừu tượng. `assetsRoot: content/diagram-assets` trong renderer nhúng local SVG vào output light/dark dưới dạng data URL; website không cần gọi catalog khi đọc. Không đặt file nhạy cảm hoặc symlink trong thư mục allowlist này.
