# Tối ưu: mốc đo và đường lùi

Hai người sẽ sửa hai máy khác nhau cùng lúc. Tài liệu này để cả hai làm giống
nhau, và để sau đó trả lời được một câu duy nhất: *bản tối ưu có thật sự tốt hơn,
hay chỉ khác đi?*

## Quy tắc chi phối tất cả

**Một tối ưu làm đổi kết quả chấm không phải tối ưu, mà là lỗi hồi quy.**

Hệ thống này gán mức DR cho ảnh đáy mắt. Nhanh gấp đôi mà đổi một ca từ độ 2
sang độ 3 là đã hỏng đúng cái thứ duy nhất nó tồn tại để làm. Nên thứ tự kiểm
tra luôn là: kết quả trước, tốc độ sau. Con số tốc độ chỉ có nghĩa sau khi đã
chứng minh kết quả không đổi.

Cái bẫy cụ thể: `/health` trên Spark đang báo `"tta": true`. Tắt TTA là đòn tăng
tốc mạnh nhất và dễ nhất — và nó **đổi đầu ra**. Nếu bản tối ưu nhanh lên nhiều
mà không giải thích được vì sao, hãy hỏi TTA trước tiên.

## Trước khi động vào bất cứ thứ gì

Trên **Spark**, tài khoản `hungntt`:

    bash tools/backup-spark.sh

Trên **prts-0**:

    cd ~ && bash tools/backup-prts0.sh

Cả hai ghi vào `~/retinax-backups/<máy>-<thời điểm>/` và in ra một `SUMMARY.txt`
nói rõ khôi phục bằng lệnh nào.

Mốc đo model cần một bộ ảnh cố định. Tạo `ai/baseline-images/` và bỏ vào 5–10
ảnh đáy mắt — **phải là cùng những ảnh đó ở mọi lần đo**, nếu không thì không so
được gì. Dùng ảnh công khai APTOS/EyePACS, thư mục này đã nằm trong `.gitignore`.

## Cái gì không được đụng

| Thứ | Lý do |
|---|---|
| `ai/dgx.env`, `server/host.env` | Chứa `JWT_SECRET`, `API_PROXY_SECRET`, khoá Gmail. Sao lưu chỉ ghi **tên biến** và sha256, không ghi giá trị. Đổi giá trị là mọi phiên đăng nhập chết. |
| `ai/weights/`, các file `.pth` | Huấn luyện trên FGADR nên là tác phẩm phái sinh dưới thoả thuận đã ký: không rời máy, không vào git. Sao lưu chỉ ghi sha256 để biết chúng có bị thay hay không. |
| `~/retinax-data`, `~/retinax-vault` | Database và ảnh. Sao lưu bằng `snapshot.sh`, và bản chụp nằm **trong** vault. |

## Sau khi tối ưu

Chạy lại đúng script sao lưu đó (nó tự tạo thư mục mới), rồi:

    python3 tools/compare-baseline.py ~/retinax-backups/<cũ>/baseline ~/retinax-backups/<mới>/baseline

Công cụ in kết quả chấm trước, tốc độ sau, và **thoát với mã 1 nếu có ca nào đổi
grade hoặc đổi số tổn thương**. Mã 1 nghĩa là chưa nhận được bản tối ưu đó.

Kiểm thêm hai thứ:

    sha256sum -c <(awk 'NR>1{print $1"  "$4}' <cũ>/weights.manifest)   # trọng số còn nguyên?
    diff <cũ>/host.env.sha256 <(sha256sum ~/server/host.env | awk '{print $1}')   # cấu hình còn nguyên?

## Lùi lại

Code trên prts-0:

    cd ~ && tar xzf ~/retinax-backups/prts0-<thời điểm>/server.tar.gz
    bash server/run-on-host.sh stop && bash server/run-on-host.sh start

Dữ liệu trên prts-0:

    cd ~ && set -a && . server/host.env && set +a && bash snapshot.sh restore pre-opt-<thời điểm>

Code trên Spark:

    tar xzf ~/retinax-backups/spark-<thời điểm>/ai-code.tar.gz -C <repo>

## Chỗ đáng tối ưu, theo thứ tự ăn tiền

**prts-0.** Ảnh là phần nặng nhất mà trang phải tải, và mỗi ảnh đang trả kèm
`Cache-Control: no-store` — đặt từ hồi sửa lỗi content-type. Đường dẫn ảnh là
UUID và không bao giờ đổi nội dung, nên `private, max-age=..., immutable` là an
toàn và là đòn mạnh nhất ở máy này. Sau đó mới tới nén JSON cho danh sách ca.
Đừng đụng vào `RATE_AI_USER_CONCURRENT=1`: đó là giới hạn có chủ ý, không phải
nút thắt cần gỡ.

**Spark.** TTA, độ chính xác fp16, batch, TensorRT — theo thứ tự rủi ro giảm
dần về phía sau. Ba cái sau có thể giữ nguyên đầu ra; TTA thì không.

**Cả hệ thống.** Trần thật sự không nằm ở hai máy mà ở đường hầm: cloudflared
quick tunnel chỉ giữ một kết nối tới edge và chặn ở 200 request đồng thời. Tối ưu
model xuống còn một nửa cũng không vượt được trần đó.
