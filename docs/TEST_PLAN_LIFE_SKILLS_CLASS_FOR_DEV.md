# Test Plan: Google Meet cho lớp KNS

## Mục tiêu

Pilot auto check-in Google Meet với 5 lớp KNS đang hoạt động sẵn.

Tận dụng dữ liệu hiện có:

- Lịch học: `kns_class_sessions`
- Roster: `students.life_skill_schedule`
- Email học sinh: `students.classin_id`
- Kết quả điểm danh: `kns_attendance_manual`

Không cần tạo lớp hoặc assign lại học sinh nếu mentor dashboard đang hiển thị
đúng roster của 5 lớp.

## 1. Chuẩn bị 5 lớp

Mỗi lớp dùng một Google Meet URL riêng.

### Kiểm tra lịch và roster

```sql
SELECT id, class_name, start_at, end_at, teacher_user_profile_id, meeting_url
FROM kns_class_sessions
WHERE class_name IN ('<class_1>', '<class_2>', '<class_3>', '<class_4>', '<class_5>')
  AND start_at >= NOW()
ORDER BY start_at;

SELECT life_skill_schedule, COUNT(*)
FROM students
WHERE life_skill_schedule IN ('<class_1>', '<class_2>', '<class_3>', '<class_4>', '<class_5>')
GROUP BY life_skill_schedule;
```

Nếu roster đã đúng, chỉ cần bổ sung Meet URL cho các session pilot:

```sql
UPDATE kns_class_sessions
SET meeting_url = '<meet_url>'
WHERE class_name = '<class_name>'
  AND start_at >= NOW()
  AND status = 'scheduled';
```

Extension match session bằng Meet code trong `meeting_url`. Thời điểm join phải
nằm trong buổi học hoặc cách `start_at` không quá 12 giờ.

### Chuẩn bị extension

- Cài extension bản mới nhất cho mentor.
- Mentor mở đúng Google Meet URL của lớp.
- Link Google handle của học sinh trong popup extension khi cần.

Không cần tạo placeholder trong `kns_classin`.

## 2. Checklist trước buổi test

- [ ] Session có đúng `meeting_url`, `start_at`, `end_at`
- [ ] Session được gán đúng mentor
- [ ] Mentor dashboard hiển thị đúng roster lớp
- [ ] Học sinh có `classin_id`
- [ ] Extension đã được cài và load

## 3. Test chính

### Student auto check-in

1. Mentor mở Meet URL của lớp và bật extension.
2. Student join Google Meet.
3. Link handle nếu student chưa được mapping.
4. Đợi extension auto check-in.

Kỳ vọng:

- Popup hiển thị student đã check-in.
- Có row trong `kns_attendance_manual` với:
  - `attendance = 'Attendance'`
  - `source = 'extension'`
- Mentor dashboard hiển thị student có mặt.

```sql
SELECT session_id, student_email, attendance, source, marked_at
FROM kns_attendance_manual
WHERE session_id = '<session_id>'
ORDER BY marked_at DESC;
```

### Các case cần kiểm tra thêm

| Case | Kỳ vọng |
|---|---|
| Student chưa link handle | API trả `handle_not_linked`, không ghi attendance |
| Meet URL không khớp session | API trả `session_not_found` |
| Nhiều student cùng join | Mỗi student có tối đa một attendance row |
| Mentor join lớp KNS | Extension acknowledge; hiện chưa ghi attendance mentor |

## 4. Debug

```bash
ssh -i ~/.ssh/id_ed25519 root@160.191.244.71
pm2 logs meet-capture-api --lines 100 | grep -E 'AutoCheckin|Checkin'
```

Logs thường gặp:

| Log | Ý nghĩa |
|---|---|
| `[AutoCheckin] kns matched and synced` | Auto check-in thành công |
| `[AutoCheckin] kns matched but classin sync missed` | Check-in vẫn thành công; chỉ thiếu legacy ClassIn sync |
| `[AutoCheckin] mentor kns acknowledged` | Mentor được nhận diện trong lớp KNS |

## 5. Tiêu chí pilot thành công

- Cả 5 lớp match đúng Meet URL và session.
- Học sinh đã link handle được auto check-in ổn định.
- Không ghi duplicate attendance.
- Mentor dashboard hiển thị đúng số học sinh có mặt.
- Không cần chỉnh `students.life_skill_schedule` trong quá trình pilot.
