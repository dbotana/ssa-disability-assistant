# Interview questions to translate

Generated from src/schema.js by tools/export-questions.mjs. Do not edit by hand.
Translate the text after each label. Keep the meaning, not the word order.

Q = the spoken question, WARN = spoken before the question, HINT = spoken after a
misunderstood answer, OPTION = an answer the person may say.

## Choosing your form

### 1. forms
Q: Which form are we filling out today: Social Security's Adult Disability Starter Kit, Maine's Developmental Services Intake Application, or both?
HINT: The Starter Kit helps you get ready to apply for Social Security disability benefits. The Developmental Services application is how adults with an intellectual disability or autism apply to Maine for services. Say starter kit, developmental services, or both.
OPTION: Adult Disability Starter Kit
OPTION: Developmental Services Intake Application
OPTION: Both forms

## Who is filling out this application

### 2. for_self
Q: Are you filling out this application for yourself?
HINT: Say no if you are a parent, guardian, caseworker, or anyone else helping the person applying.

### 3. helper_name
Q: What is your name, or the name of your agency?
WARN: Thank you for helping. From here on, every question is about the person applying, even when I say you. First, a few details about you.

### 4. helper_address
Q: What is your mailing address? Just the street or post office box for now.

### 5. helper_city
Q: What town or city is that in?
HINT: If it is outside Maine, include the state too.

### 6. helper_county
Q: What county is that in?

### 7. helper_zip
Q: What is the zip code?

### 8. helper_phone
Q: What is your phone number?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

### 9. helper_fax
Q: What is your fax number? Say skip if you do not have one.
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

### 10. helper_email
Q: What is your email address?
HINT: You can say it like john dot smith at gmail dot com, or say skip.

## Basic information about you

### 11. first_name
Q: What is your legal first name?

### 12. last_name
Q: What is your legal last name?

### 13. date_of_birth
Q: What is your date of birth? Say the month, the day, and then the year.
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

### 14. birth_city
Q: What city were you born in?

### 15. birth_state
Q: What state or province were you born in?

### 16. birth_country
Q: What country were you born in?

### 17. ssn
Q: What is your Social Security number?
WARN: Next I need your Social Security number. It is saved only on this device, and it is never sent to Social Security. You can say skip to leave it blank, or type it instead of saying it.
HINT: You can say the nine digits one at a time, and it is fine to pause between groups.

## Your address and background

### 18. home_street
Q: What is your street address?
HINT: Just the number and street. I will ask for the town next.

### 19. home_town
Q: What town or city do you live in?

### 20. home_state
Q: What state do you live in?

### 21. home_zip
Q: What is your zip code?

### 22. mailing_different
Q: Is your mailing address different from your street address?

### 23. mailing_address
Q: What is your full mailing address, including the town, state, and zip code?

### 24. applicant_phone
Q: What is your phone number?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

### 25. applicant_email
Q: What is your email address? Say skip if you do not have one.
HINT: You can say it like john dot smith at gmail dot com.

### 26. primary_language
Q: What is your primary language?

### 27. deaf_hoh
Q: Are you deaf or hard of hearing?

### 28. gender
Q: The form asks for gender, and it only offers male or female. Which should I put?
HINT: Say male or female, or say skip to leave it blank.
OPTION: Male
OPTION: Female

### 29. mainecare_number
Q: What is your MaineCare number? Say skip if you do not have one.

### 30. marital_status
Q: What is your marital status: never married, married, separated, divorced, or widowed?
OPTION: Never married
OPTION: Married
OPTION: Separated
OPTION: Divorced
OPTION: Widowed

## Guardian or power of attorney

### 31. has_guardian
Q: Do you have a legal guardian, or someone with power of attorney for you?

### 32. guardian_name
Q: What is their full name?
WARN: Maine asks for a copy of the guardianship or power of attorney paperwork to be sent with this application.

### 33. guardian_relationship
Q: How are they related to you?
HINT: For example, parent, sister, or professional guardian.

### 34. guardian_address
Q: What is their mailing address? Just the street or post office box for now.

### 35. guardian_city
Q: What town or city is that in?
HINT: If it is outside Maine, include the state too.

### 36. guardian_county
Q: What county is that in?

### 37. guardian_zip
Q: What is the zip code?

### 38. guardian_phone
Q: What is their phone number?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

### 39. guardian_email
Q: What is their email address? Say skip if you do not know it.

## Emergency contact

### 40. ec_same_as_guardian
Q: Should your guardian also be listed as your emergency contact?

### 41. ec_name
Q: Who should be contacted in an emergency? Tell me their full name.
HINT: Usually a guardian or your closest family member. Say skip to leave this blank.

### 42. ec_relationship
Q: How are they related to you?

### 43. ec_address
Q: What is their street address?

### 44. ec_city
Q: What town or city is that in?
HINT: If it is outside Maine, include the state too.

### 45. ec_county
Q: What county is that in?

### 46. ec_zip
Q: What is the zip code?

### 47. ec_phone
Q: What is their phone number?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

### 48. ec_email
Q: What is their email address? Say skip if you do not know it.

## Your medical conditions

### 49. conditions
ITEM: condition
ENTRY: What is the medical condition that limits your ability to work? If you have more than one, we will take them one at a time.
REPEAT: Do you have another medical condition to add?

#### name
Q: What is the name of this condition?
HINT: If you have cancer, please include the stage and type.

### 50. diagnoses
ITEM: diagnosis
ENTRY: Do you have a current diagnosis to list? It can be any physical, mental, or developmental condition.
REPEAT: Do you have another diagnosis to list?

#### name
Q: What is the diagnosis?

### 51. onset_date
Q: What month and year did your condition begin to limit your ability to work?
HINT: An approximate month and year is fine. This is the date your condition started making it hard to work, not the date you stopped working.

## Allergies, diet, and developmental diagnosis

### 52. medication_allergies
Q: Do you have any medication allergies? Tell me what they are, or say none.

### 53. food_allergies
Q: Any food allergies? Tell me what they are, or say none.

### 54. environmental_allergies
Q: Any environmental allergies, such as pollen, dust, or animals? Tell me what they are, or say none.

### 55. dietary_restrictions
Q: Do you have any dietary restrictions? Tell me what they are, or say none.

### 56. has_idd_dx
Q: Have you been diagnosed with an intellectual disability, a developmental disability, or autism?

### 57. idd_dx_date
Q: About when were you diagnosed? A month and year is fine.
HINT: If you do not know, say skip.

### 58. idd_age_at_dx
Q: How old were you when you were diagnosed?

### 59. idd_diagnoses
ITEM: confirmed diagnosis
ENTRY: Has a psychological evaluation with IQ and adaptive scores confirmed a diagnosis?
REPEAT: Did the evaluation confirm another diagnosis?

#### name
Q: What is the confirmed diagnosis?

## Your doctors, hospitals, and clinics

### 60. providers
ITEM: provider
ENTRY: Do you have a doctor, hospital, or clinic to add?
REPEAT: Do you have another doctor, hospital, or clinic to add?

#### name
Q: What is the name of this provider or facility?

#### address
Q: What is the address for this provider or facility?
HINT: Street, city, and state is enough. You can say skip if you do not have it.

#### phone
Q: What is the phone number for this provider or facility?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

#### first_seen
Q: What date did you first see this provider? If this was a hospital stay, give me the admission date.
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

#### last_seen
Q: What date did you last see this provider? If this was a hospital stay, give me the discharge date. You can say still seeing them.
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

## Medical tests

### 61. tests
ITEM: test
ENTRY: Have you had, or do you have scheduled, any medical test related to your condition?
REPEAT: Do you have another medical test to add?

#### name
Q: What is the name of this test?

#### date
Q: What date was, or will, this test be performed?
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

#### ordered_by
Q: Who ordered this test?

## Your medications

### 62. medications
ITEM: medication
ENTRY: Are you currently taking any medicine, prescribed or over the counter?
REPEAT: Do you have another medication to add?

#### name
Q: What is the name of this medication?

#### reason
Q: Why do you take it?
HINT: If you are not sure, you can say skip.

#### prescribed_by
Q: Which provider prescribed it?

## Workers' compensation

### 63. wc_receives
Q: Do you receive workers' compensation or another disability benefit?

### 64. wc_injury_date
Q: What is the date of injury?
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

### 65. wc_claim_number
Q: What is the claim number?

### 66. wc_settlement
Q: Is there a settlement agreement?

### 67. wc_source
Q: What is the source of the payment?

### 68. wc_amount
Q: What is the payment amount?

## Permission to request your medical records

### 69. records_permission
Q: Do you give permission for Social Security to request your medical records directly from your providers?

## People who know about your condition

### 70. ref1_name
Q: Can you give me the name of one person, other than a medical provider, who knows about your condition?

### 71. ref1_phone
Q: What is that person's phone number?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

### 72. ref2_name
Q: Can you give me the name of a second such person? This one is optional.

### 73. ref2_phone
Q: What is that person's phone number?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

## Your earnings record

### 74. earnings_reviewed
Q: Have you reviewed your Social Security earnings record for accuracy?

## Your work history

### 75. jobs
ITEM: job
ENTRY: Did you work a job in the 5 years before your condition began to limit your work?
REPEAT: Did you work another job in that 5 year period?

#### employer
Q: What was the employer's name?

#### job_title
Q: What was your job title?
HINT: For example, cook.

#### business_type
Q: What type of business was this?
HINT: For example, restaurant.

#### start
Q: What month and year did you start this job?
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

#### end
Q: What month and year did this job end? You can say still working.
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

#### hours_per_day
Q: On average, how many hours a day did you work at this job?

#### days_per_week
Q: And how many days a week?

#### pay_amount
Q: How much were you paid? Just the amount for now.
HINT: For example, twenty dollars. I will ask next whether that was per hour, per week, or some other period.

#### pay_frequency
Q: Was that per hour, per day, per week, every two weeks, twice a month, per month, or per year?
OPTION: Per hour
OPTION: Per day
OPTION: Per week
OPTION: Every two weeks
OPTION: Twice a month
OPTION: Per month
OPTION: Per year

### 76. currently_employed
Q: Are you working right now?

### 77. ds_jobs
ITEM: job
ENTRY: Have you ever had a job? It can be paid, part time, or supported employment.
REPEAT: Have you had another job?

#### employer
Q: Where did you work?

#### job_title
Q: What was your job there?
HINT: For example, stocking shelves.

#### start
Q: What month and year did you start?
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

#### end
Q: What month and year did it end? You can say still working.
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

### 78. vr_involvement
Q: Have you worked with Vocational Rehabilitation? If so, tell me briefly what they helped with. If not, say no.

### 79. volunteer_experience
Q: Have you done any volunteer work? If so, tell me about it, or say none.

## Your education

### 80. in_school
Q: Are you going to school right now?

### 81. graduation_date
Q: When do you expect to graduate? A month and year is fine.
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

### 82. education_level
Q: What is the highest level of education you completed?

### 83. education_year
Q: What year did you complete it?

### 84. education_school
Q: What school or institution did you complete it at?

### 85. special_ed
Q: Did you receive special education services?

### 86. special_ed_where
Q: Where did you receive special education services?

### 87. special_ed_year
Q: What year did you complete special education services?

### 88. has_504_plan
Q: Have you ever had a 504 plan at school?

### 89. psychoed_eval
Q: Have you had a psychoeducational evaluation?
HINT: That is an evaluation of learning and thinking skills, often done through school.

## Job, trade, or vocational training

### 90. training
ITEM: training program
ENTRY: Have you completed any specialized job, trade, or vocational training?
REPEAT: Do you have another training program to add?

#### name
Q: What was the name of this training program?

#### completed
Q: What date did you complete it?
HINT: Say the month and then the year. For example, March, nineteen seventy nine.

## Current and past marriages

### 91. marriages
ITEM: marriage
ENTRY: Have you ever been married?
REPEAT: Do you have another marriage to add?

#### spouse_name
Q: What is your spouse's or former spouse's full name?

#### spouse_ssn
Q: What is your spouse's or former spouse's Social Security number?
HINT: You can say the nine digits one at a time, and it is fine to pause between groups.

#### spouse_dob
Q: What is your spouse's or former spouse's date of birth?
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

#### marriage_city
Q: What city did you get married in?

#### marriage_state
Q: What state did you get married in?

#### marriage_country
Q: What country did you get married in?

#### marriage_date
Q: What date did you get married?
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

#### still_active
Q: Is this marriage still active?

#### divorce_date
Q: What date did you get divorced?
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

#### spouse_died
Q: Did this spouse pass away?

#### spouse_death_date
Q: What date did this spouse pass away?
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

## Your children

### 92. children
ITEM: child
ENTRY: Do you have a child age 17 or younger, a child age 18 to 19 who is in school full time, or a child of any age with a disability that began at or before age 21?
REPEAT: Do you have another child to add?

#### first_name
Q: What is this child's first name?

#### last_name
Q: What is this child's last name?

## People who live with you

### 93. living_arrangement
Q: What is your current living arrangement? For example, living with family, in your own apartment, or in a group home.

### 94. household
ITEM: household member
ENTRY: Does anyone live with you?
REPEAT: Do you have another household member to add?

#### name
Q: What is this person's name?

#### dob
Q: What is this person's date of birth?
HINT: Say the month, then the day, then the year. For example, March fourteenth, nineteen seventy nine.

## Your home

### 95. rents
Q: Do you rent your home?

### 96. landlord_name
Q: What is your landlord's name?

### 97. landlord_phone
Q: What is your landlord's phone number?
HINT: You can say the ten digits one at a time, and it is fine to pause between groups.

### 98. has_rental_contract
Q: Do you have a rental contract on file?

### 99. has_admission_agreement
Q: Do you have an admission agreement on file?

### 100. recent_admission
Q: Have you been admitted to, or discharged from, a hospital or institution recently?

### 101. has_admit_papers
Q: Do you have the admit or discharge papers on file?

## Your current income

### 102. income_sources
ITEM: income source
ENTRY: Do you currently receive income from any source? That includes pay, self-employment, unemployment, dividends, stocks, a pension, an insurance payout, alimony, child support, gambling winnings, or a state disability payment.
REPEAT: Do you have another income source to add?

#### kind
Q: What type of income is this?

#### monthly_amount
Q: What is the approximate monthly amount?

#### has_documentation
Q: Do you have documentation for this income?

## Other financial resources

### 103. resources
ITEM: resource
ENTRY: Do you have any other financial resource? That includes a bank account, a car title or loan, a burial contract, a trust fund, a life insurance policy, or stocks and bonds.
REPEAT: Do you have another resource to add?

#### kind
Q: What type of resource is this?

#### value
Q: What is the approximate value?

## Daily living activities

### 104. eating_level
Q: Eating. Which fits best?
WARN: For each of the next activities, tell me which fits best: A, independent. B, needs supervision. C, needs skills training. D, needs physical assistance. Or E, total care. If it is anything but independent, I will ask you to explain briefly.
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 105. eating_explain
Q: Briefly, what help is needed with eating?
HINT: For example, who helps, and how often. You can say skip.

### 106. dressing_level
Q: Dressing. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 107. dressing_explain
Q: Briefly, what help is needed with dressing?
HINT: For example, who helps, and how often. You can say skip.

### 108. toileting_level
Q: Using the toilet. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 109. toileting_explain
Q: Briefly, what help is needed with toileting?
HINT: For example, who helps, and how often. You can say skip.

### 110. bathing_level
Q: Bathing. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 111. bathing_explain
Q: Briefly, what help is needed with bathing?
HINT: For example, who helps, and how often. You can say skip.

### 112. grooming_level
Q: Grooming, such as brushing teeth and hair. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 113. grooming_explain
Q: Briefly, what help is needed with grooming?
HINT: For example, who helps, and how often. You can say skip.

### 114. mobility_level
Q: Mobility, meaning getting around. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 115. mobility_explain
Q: Briefly, what help is needed with mobility?
HINT: For example, who helps, and how often. You can say skip.

## Safety

### 116. physical_danger_level
Q: Avoiding physical danger. Which fits best?
WARN: For each of the next activities, tell me which fits best: A, independent. B, needs supervision. C, needs skills training. D, needs physical assistance. Or E, total care. If it is anything but independent, I will ask you to explain briefly.
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 117. physical_danger_explain
Q: Briefly, what help is needed with physical danger?
HINT: For example, who helps, and how often. You can say skip.

### 118. emotional_jeopardy_level
Q: Avoiding emotional harm. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 119. emotional_jeopardy_explain
Q: Briefly, what help is needed with emotional harm?
HINT: For example, who helps, and how often. You can say skip.

### 120. healthy_relationships_level
Q: Keeping relationships healthy. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 121. healthy_relationships_explain
Q: Briefly, what help is needed with healthy relationships?
HINT: For example, who helps, and how often. You can say skip.

### 122. judgment_level
Q: Judgment about personal conduct. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 123. judgment_explain
Q: Briefly, what help is needed with judgment?
HINT: For example, who helps, and how often. You can say skip.

## Household activities

### 124. cooking_level
Q: Cooking. Which fits best?
WARN: For each of the next activities, tell me which fits best: A, independent. B, needs supervision. C, needs skills training. D, needs physical assistance. Or E, total care. If it is anything but independent, I will ask you to explain briefly.
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 125. cooking_explain
Q: Briefly, what help is needed with cooking?
HINT: For example, who helps, and how often. You can say skip.

### 126. laundry_level
Q: Laundry. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 127. laundry_explain
Q: Briefly, what help is needed with laundry?
HINT: For example, who helps, and how often. You can say skip.

## Getting around the community

### 128. shopping_level
Q: Shopping. Which fits best?
WARN: For each of the next activities, tell me which fits best: A, independent. B, needs supervision. C, needs skills training. D, needs physical assistance. Or E, total care. If it is anything but independent, I will ask you to explain briefly.
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 129. shopping_explain
Q: Briefly, what help is needed with shopping?
HINT: For example, who helps, and how often. You can say skip.

### 130. transportation_level
Q: Transportation. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 131. transportation_explain
Q: Briefly, what help is needed with transportation?
HINT: For example, who helps, and how often. You can say skip.

### 132. banking_level
Q: Banking and handling money. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 133. banking_explain
Q: Briefly, what help is needed with banking?
HINT: For example, who helps, and how often. You can say skip.

### 134. recreation_level
Q: Recreation. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 135. recreation_explain
Q: Briefly, what help is needed with recreation?
HINT: For example, who helps, and how often. You can say skip.

## Keeping up relationships

### 136. rel_family_level
Q: Relationships with family. Which fits best?
WARN: For each of the next activities, tell me which fits best: A, independent. B, needs supervision. C, needs skills training. D, needs physical assistance. Or E, total care. If it is anything but independent, I will ask you to explain briefly.
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 137. rel_family_explain
Q: Briefly, what help is needed with family relationships?
HINT: For example, who helps, and how often. You can say skip.

### 138. rel_friends_level
Q: Relationships with friends. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 139. rel_friends_explain
Q: Briefly, what help is needed with friends?
HINT: For example, who helps, and how often. You can say skip.

### 140. rel_coworkers_level
Q: Relationships with coworkers. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 141. rel_coworkers_explain
Q: Briefly, what help is needed with coworkers?
HINT: For example, who helps, and how often. You can say skip.

### 142. rel_support_staff_level
Q: Relationships with support staff. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 143. rel_support_staff_explain
Q: Briefly, what help is needed with support staff?
HINT: For example, who helps, and how often. You can say skip.

## Communication

### 144. expressive_level
Q: Expressing yourself, called expressive communication. Which fits best?
WARN: For each of the next activities, tell me which fits best: A, independent. B, needs supervision. C, needs skills training. D, needs physical assistance. Or E, total care. If it is anything but independent, I will ask you to explain briefly.
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 145. expressive_explain
Q: Briefly, what help is needed with expressive communication?
HINT: For example, who helps, and how often. You can say skip.

### 146. receptive_level
Q: Understanding others, called receptive communication. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 147. receptive_explain
Q: Briefly, what help is needed with receptive communication?
HINT: For example, who helps, and how often. You can say skip.

### 148. sign_language_level
Q: Sign language. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E. If this does not apply, say skip.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 149. sign_language_explain
Q: Briefly, what help is needed with sign language?
HINT: For example, who helps, and how often. You can say skip.

### 150. visual_gestural_level
Q: Visual or gestural communication, such as pointing or pictures. Which fits best?
HINT: Say independent, needs supervision, needs skills training, needs physical assistance, or total care. Or say the letter, A through E. If this does not apply, say skip.
OPTION: Independent
OPTION: Needs supervision
OPTION: Needs skills training
OPTION: Needs physical assistance
OPTION: Total care

### 151. visual_gestural_explain
Q: Briefly, what help is needed with visual communication?
HINT: For example, who helps, and how often. You can say skip.

## Documents to send with the application

### 152. has_comprehensive_eval
Q: Do you have a comprehensive evaluation, done by a licensed physician or psychologist?
WARN: Maine asks for some evaluations to be sent with this application. I will ask which ones you already have. If you do not have them, the intake coordinator can arrange them.

### 153. has_adaptive_test
Q: Do you have a completed adaptive behavior test?

### 154. has_iq_test
Q: Do you have a completed intelligence test, sometimes called an IQ test?

### 155. has_other_assessments
Q: Do you have any other assessments, such as a psychosocial evaluation or an education plan, called an IEP?

## Direct deposit for benefit payments

### 156. routing_number
Q: What is your bank's 9-digit routing number?
WARN: Last section. I need your bank routing and account numbers for direct deposit. They are saved only on this device, and they are never sent to Social Security. You can say skip to leave them blank, or type them instead of saying them.
HINT: You can say the nine digits one at a time, and it is fine to pause between groups.

### 157. account_number
Q: What is your bank account number?
HINT: You can say the digits one at a time, and it is fine to pause between groups.
