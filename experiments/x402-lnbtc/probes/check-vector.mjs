import { recoverPayee, descriptionHash } from "./bolt11-payee.mjs";
const inv = "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f";
const payee = recoverPayee(inv), dh = descriptionHash(inv);
console.log("recovered payee :", payee, payee === "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" ? "== spec payTo ✓" : "MISMATCH");
console.log("description hash:", dh, dh === "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018" ? "== spec requestHash ✓" : "MISMATCH");
