# Benchmark framework cho mentor-side Meet capture v2

## 1. Mục tiêu

Khung benchmark này nhằm trả lời 5 câu hỏi:

- Tải đầu vào của bài test là gì?
- Hệ thống còn hoạt động ổn đến mức nào khi số student tăng?
- Khi student join / leave / tab refresh thì mapping video còn ổn không?
- Actual video length của từng student có bám sát thời gian xuất hiện thực tế không?
- Khi quá tải thì hỏng theo kiểu nào?

Benchmark ở đây không nhằm chứng minh production-ready hoàn chỉnh, mà nhằm:

- xác định ngưỡng chịu tải bước đầu
- phát hiện bottleneck chính ở máy mentor và backend
- phát hiện lệch participant mapping sớm
- có số liệu đủ rõ để báo cáo lại PM/mentor

## 2. Các nhóm benchmark cần có

### 2.1. Workload benchmark

Cần mô tả rõ đầu vào của mỗi bài test:

- số student đồng thời: `1 -> 2 -> 5 -> 10 -> 20`
- trạng thái của student:
  - bật/tắt camera
  - bật/tắt mic
  - nói luân phiên hay nói đồng thời
- mentor có bật mic hay không
- thời lượng của mỗi mức test, ví dụ `5-10 phút`
- có dùng guided manual participant tag hay không
- có thao tác churn hay không:
  - student join lần lượt
  - student leave giữa chừng
  - mentor switch tab
  - reconnect / camera toggle

Mục đích của nhóm này là để mỗi lần test đều có cùng cách tải, tránh kết quả bị khó so sánh.

### 2.2. Benchmark phía máy record (mentor)

Cần đo các chỉ số ở phía máy mentor:

- CPU của Chrome / tab Meet
- RAM của Chrome
- mức độ lag của UI Meet
- số remote track đang capture
- số event phát sinh mỗi phút
- dung lượng dữ liệu sinh ra mỗi phút
- số batch đang queue chờ upload

Mục đích:

- biết máy mentor bắt đầu lag ở mức bao nhiêu student
- biết extension tạo tải tăng nhanh ở CPU, RAM hay upload queue

### 2.3. Benchmark phía backend

Cần đo các chỉ số ở phía backend:

- số request batch mỗi phút
- số event nhận được mỗi phút
- số byte upload mỗi phút
- tốc độ tăng số file và dung lượng thư mục capture
- retry/error rate
- tình trạng `/health`
- số session còn ghi ổn sau join / leave churn

Mục đích:

- biết backend có còn nhận dữ liệu ổn không
- biết nghẽn nằm ở upload hay ghi file

### 2.4. Benchmark chất lượng capture

Không chỉ đo tài nguyên, mà cần đo chất lượng dữ liệu capture:

- còn capture được `mentor audio` hay không
- còn capture được `shared student audio` hay không
- còn capture được `student video` hay không
- tỷ lệ participant bị `unknown` hoặc bị gán sai tên
- có sinh participant rác từ UI text hay không
- số audio chunk playable so với skipped
- actual video length của từng student có tiếp tục tăng sau khi tab switch / student leave hay không
- cùng một student có bị tách thành nhiều participant card bất thường hay không

Mục đích:

- tránh trường hợp CPU/RAM vẫn chịu được nhưng dữ liệu capture đã xuống chất lượng

### 2.5. Benchmark độ ổn định participant mapping

Với mentor-side PoC này, mapping stability là chỉ số riêng cần theo dõi:

- `joinObservedAt` của student
- `leaveObservedAt` của student
- `actualVideoDurationMs`
- `videoChunkCount`
- `streamIds count` trên cùng một student

Mục đích:

- biết student có bị tách thành nhiều stream replacement hay không
- biết stream replacement có còn tự attach về đúng student không
- biết actual recorded duration có gần với thời gian student còn hiện diện trên màn hình không

Lưu ý:

- `joinObservedAt` và `leaveObservedAt` là thời điểm backend nhìn thấy `student-video` event đầu tiên / cuối cùng
- đây là `backend-observed timeline`, không phải roster truth tuyệt đối từ Google Meet
- `actualVideoDurationMs` là tổng duration của video chunks do recorder gửi lên, dùng để so độ ổn định capture

### 2.6. Pass/fail benchmark

Mỗi mức test cần có tiêu chí pass/fail rõ:

- UI Meet phía mentor còn usable
- upload không backlog tăng vô hạn
- backend vẫn nhận được batch ổn định
- không mất hẳn `mentor audio`
- không mất hẳn `shared student audio`
- không mất hẳn `student video`
- không sinh participant rác rõ rệt
- actual video length của student không dừng bất thường khi student vẫn còn trong cuộc gọi

Nếu một mức test làm một trong các tiêu chí trên fail, thì đó là dấu hiệu đã chạm ngưỡng.

## 3. Khung benchmark đề xuất

| Nhóm | Cần đo |
| --- | --- |
| Workload | số student, camera/mic state, thời lượng, kịch bản nói, join/leave churn |
| Mentor machine | CPU, RAM, lag UI, remote track count, event/phút, queue upload |
| Backend | batch/phút, event/phút, bytes/phút, error/retry, tốc độ ghi file, `/health` |
| Capture quality | mentor audio, shared student audio, student video, unknown rate, participant rác |
| Mapping stability | joinObservedAt, leaveObservedAt, actualVideoDurationMs, chunk count, stream count per student |
| Pass/fail | usable UI, upload ổn định, không mất capture chính, duration không đứng bất thường |

## 4. Các mức benchmark nên chạy

Nên chia benchmark thành 4 mức:

### 4.1. Functional benchmark

Mức nhỏ để xác nhận hệ thống còn hoạt động đúng:

- `1-2 student`
- mục tiêu:
  - xác nhận đủ audio/video
  - xác nhận upload ổn
  - xác nhận manual tag còn dùng được

### 4.2. Mapping-stability benchmark

Mức nhỏ nhưng có churn:

- `2 student`
- kịch bản:
  - admit student A
  - admit student B
  - student A leave
  - mentor switch tab
  - student B vẫn ở lại
- mục tiêu:
  - xác nhận student B không bị tách thành participant rác
  - actual video length của student B vẫn tăng tiếp

### 4.3. Load benchmark

Mức trung bình để xem tải tăng thế nào:

- `5-10 student`
- mục tiêu:
  - đo CPU/RAM tăng ra sao
  - đo event/phút, byte/phút
  - theo dõi unknown rate, upload queue, mapping stability

### 4.4. Stress benchmark

Mức lớn để tìm ngưỡng degrade:

- `10-20+ student` hoặc đến khi hệ thống bắt đầu fail
- mục tiêu:
  - xác định bottleneck chính
  - ghi lại dấu hiệu fail đầu tiên
  - xác định mức chịu tải thực tế hiện tại

## 5. Trường dữ liệu backend nên dùng làm source of truth

Benchmark nên đọc từ backend manifest / session API thay vì popup:

- `trackStats.remoteVideoTracks`
- `trackStats.remoteAudioTracks`
- `captureSummary.studentVideoParticipants[*].joinObservedAt`
- `captureSummary.studentVideoParticipants[*].leaveObservedAt`
- `captureSummary.studentVideoParticipants[*].actualVideoDurationMs`
- `captureSummary.studentVideoParticipants[*].videoChunkCount`
- `captureSummary.studentVideoParticipants[*].streamIds`

Nếu một student có:

- `streamIds` tăng cao bất thường
- `leaveObservedAt - joinObservedAt` còn dài nhưng `actualVideoDurationMs` ngắn

thì đó là tín hiệu capture chưa ổn, thường là do stream replacement không attach lại đúng participant.

## 6. Mẫu kết quả nên ghi

| Mức test | Số student | Thời lượng | Upload status | Capture quality | Mapping stability | Kết luận |
| --- | --- | --- | --- | --- | --- | --- |
| Functional | 1-2 |  |  |  |  |  |
| Mapping stability | 2 |  |  |  |  |  |
| Load | 5-10 |  |  |  |  |  |
| Stress | 10-20+ |  |  |  |  |  |

## 7. Mẫu checklist cho từng student

| Student | joinObservedAt | leaveObservedAt | actualVideoDuration | videoChunks | streamCount | Đánh giá |
| --- | --- | --- | --- | --- | --- | --- |
| Student A |  |  |  |  |  |  |
| Student B |  |  |  |  |  |  |

Gợi ý đọc nhanh:

- `actualVideoDuration` gần bằng thời gian student hiện diện: tốt
- `streamCount` tăng nhưng vẫn gộp vào đúng student, duration vẫn tăng: chấp nhận được
- `streamCount` tăng và sinh participant mới / duration đứng yên: fail mapping stability

## 8. Kết luận mong muốn sau benchmark

Sau mỗi vòng benchmark, cần rút ra được:

- mức nào hệ thống còn chạy ổn
- mức nào bắt đầu lag hoặc mất dữ liệu
- mức nào bắt đầu có participant mapping không ổn
- actual student video length còn đáng tin đến mức nào
- bottleneck chính nằm ở mentor machine hay backend
- có cần tối ưu thêm trước khi tăng quy mô hay không

## 9. Gợi ý áp dụng cho PoC hiện tại

Với PoC mentor-side hiện tại, benchmark nên ưu tiên theo thứ tự:

1. `Functional benchmark`: `1-2 student`
2. `Mapping-stability benchmark`: `2 student` có join/leave/tab switch
3. `Load benchmark`: `5 student`
4. `Stress benchmark`: `10 student` rồi tăng tiếp nếu còn ổn

Lý do:

- remote student audio vẫn là shared audio
- participant mapping vẫn là best-effort
- tab switch / stream replacement là điểm rủi ro thật sự
- benchmark hiện tại cần chứng minh `capture data stable enough`, chưa phải production pipeline hoàn chỉnh
