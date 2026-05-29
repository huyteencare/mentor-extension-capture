# Research Check-in

## Mục tiêu

Xác minh xem Google Meet có thể cung cấp email usable của participant để phục vụ check-in hay không, ưu tiên UX tự động.

## Kết quả chính

- Track A (DOM / People panel) không lấy được email usable.
- Track B (Google Meet API) đã match được:
  - `attendance-candidate -> conferenceRecord -> participant -> participantSession`
  - `signedinUser.user`
- `signedinUser.user` hiện là identity signal mạnh nhất đã prove được.

## Test cases

Chi tiết các case đã test:

- [CHECK_IN_RESEARCH_TEST_CASES_VN.md](/home/huy/workspace/teencare/extension-webcam-v2/docs/CHECK_IN_RESEARCH_TEST_CASES_VN.md)

## Kết luận hiện tại

- Email không thể xem là đã giải được cho external users.
- Email của account có domain `@teencare.vn` cũng không chắc tự động lấy được.
- Chỉ internal Workspace-style case rõ ràng mới đang cho ra email ổn.

## Hướng đi đã chọn

- Tiếp tục dùng `signedinUser.user` làm identity anchor chính.
- Extension phải tự auto emit `attendance-candidate` khi participant join, không phụ thuộc vào bấm Save Name.
- DEV mode sẽ surfacing `candidateId`, `probeStatus`, `participantType`, `signedinUser.user` để debug nhanh.
- Với case không ra email, hướng product thực tế là:
  - auto probe trước
  - nếu chưa đủ chắc thì manual link một lần
  - các session sau reuse theo `signedinUser.user`
