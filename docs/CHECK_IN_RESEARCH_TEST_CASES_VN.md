# Check-in Research Test Cases

## Case 1: `Ducchuy`

- Meet probe: match được `signedinUser.user = users/112121410834113088974`
- People API: resolve được `people/112121410834113088974`
- Kết quả email: `emailAddresses = []`

Kết luận:

- match identity handle thành công
- không lấy được email usable

## Case 2: `Another Account Just`

Ban đầu:

- backend match nhầm sang participant `TeenCare Global` vì session đó đang overlap

Sau khi fix scoring:

- match đúng `meetDisplayName = Another Account Just`
- match được `signedinUser.user = users/117369108119322273649`

Kết luận:

- path Meet API đúng
- backend matching đã ổn hơn cho case join gần thời điểm nhau

## Case 3: `TeenCare Global`

- Meet probe: match được `signedinUser.user = users/113317505806612900108`
- People API: resolve được `people/113317505806612900108`
- Kết quả email: `info@teencare.vn`
- Source: `DOMAIN_PROFILE`

Kết luận:

- đây là case internal Workspace-style rõ nhất
- email lấy được

## Case 4: `Vu Canh` với account `@teencare.vn`

- Meet probe: match đúng participant `Vu Canh`
- `signedinUser.user = users/114397724713755196710`
- People API: resolve được `people/114397724713755196710`
- Kết quả email: `emailAddresses = []`
- Source: `PROFILE`

Kết luận:

- account có domain `@teencare.vn` không tự động đồng nghĩa với case internal email-resolvable
- vẫn có thể không lấy được email

## Tổng hợp

- External signed-in: đã có case không lấy được email
- Internal Workspace-style: đã có case lấy được email
- Domain `@teencare.vn` tự nó chưa đủ để kết luận sẽ lấy được email
