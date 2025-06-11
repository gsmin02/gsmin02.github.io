const parseCSV = (csv) => {
    const rows = csv.trim().split("\n").slice(1);
    return rows.map((row) => {
        const regex = /(".*?"|[^,]+)/g;
        return row.match(regex).map((item) => item.replace(/(^"|"$)/g, ""));
    });
};

const parsedData = parseCSV(data);
let currentIndex = 0;

function showQuestion(index) {
    const questionContainer = document.getElementById("question-container");

    let imageHtml = '';
    if (parsedData[index][4]) {
        imageHtml = `<img src="${parsedData[index][4]}" class="question-image mb-3" alt="문제 이미지" style="max-width: 100%; height: auto;">`;
    }
    
    questionContainer.innerHTML = `
        <div class="card question-card">
            <div class="card-body">
                <h5 class="card-title">${parsedData[index][0]}. ${parsedData[index][1]}</h5>
                ${imageHtml}
                <ul class="list-group list-group-flush">
                    <li class="list-group-item"><input type="text" id="user-answer" class="form-control" placeholder="입력"/></li>
                </ul>
                <div class="d-flex align-items-center mt-2">
                    <button class="btn btn-custom mt-3" onclick="checkAnswer()">제출</button>
                    <span id="result-message" class="ml-auto"></span> </div>
                <div class="d-flex align-items-center mt-2">
                    <button id="toggle-answer-btn" class="btn btn-custom mt-3" onclick="toggleCorrectAnswer()">정답 확인</button>
                </div>
                <br>
                <div id="answer" class="answer ml-auto" style="display: none;"></div>
                <div id="explanation" class="explanation ml-auto" style="display: none;"></div>
            </div>
        </div>
    `;

    // 해설 데이터가 있을 경우 explanation div를 표시
    if (parsedData[index][3]) {
        document.getElementById("explanation").style.display = "block"; // block 또는 flex 등 적절한 display 속성 사용
    } else {
        document.getElementById("explanation").style.display = "none";
    }

    document.getElementById("prev-btn").style.display =
        index === 0 ? "none" : "inline-block";
    document.getElementById("next-btn").style.display =
        index === parsedData.length - 1 ? "none" : "inline-block";

    updateProgress(index);
}

function checkAnswer() {
    const userAnswer = document.getElementById("user-answer").value.trim();
    const correctAnswer = parsedData[currentIndex][2].trim();
    const resultMessageElement = document.getElementById("result-message");

    if (userAnswer === correctAnswer) {
        resultMessageElement.textContent = "정답";
        resultMessageElement.style.color = "green";
    } else {
        resultMessageElement.textContent = "오답";
        resultMessageElement.style.color = "red";
    }
    setTimeout(() => {
        resultMessageElement.textContent = "";
    }, 3000);
}

function toggleCorrectAnswer() {
    const answerElement = document.getElementById("answer"); // explanation -> answer로 변경
    const explanationElement = document.getElementById("explanation"); // 새로운 explanation div
    const toggleButton = document.getElementById("toggle-answer-btn");
    const correctAnswer = parsedData[currentIndex][2];
    const explanation = parsedData[currentIndex][3]; // 해설 데이터

    if (answerElement.style.display === "none") {
        // 정답을 보여줄 때
        answerElement.style.display = "inline";
        answerElement.textContent = `정답: ${correctAnswer}`;

        if (explanation) { // 해설이 있다면 explanation div에 내용 추가
            explanationElement.textContent = `해설: ${explanation}`;
            explanationElement.style.display = "block"; // 해설이 있을 때만 표시
        } else {
            explanationElement.style.display = "none"; // 해설이 없으면 숨김
        }
        toggleButton.textContent = "정답 숨기기";
    } else {
        // 정답을 숨길 때
        answerElement.style.display = "none";
        answerElement.textContent = ""; // 내용도 초기화
        explanationElement.style.display = "none"; // 해설도 숨김
        explanationElement.textContent = ""; // 해설 내용도 초기화
        toggleButton.textContent = "정답 확인";
    }
}

function updateProgress(index) {
    const progress = document.getElementById("progress");
    progress.innerHTML = `문제 ${index + 1} / ${parsedData.length}`;
}

function nextQuestion() {
    if (currentIndex < parsedData.length - 1) {
        currentIndex++;
        showQuestion(currentIndex);
    }
}

function prevQuestion() {
    if (currentIndex > 0) {
        currentIndex--;
        showQuestion(currentIndex);
    }
}

function selectQuestion(event) {
    if (event.keyCode === 13) {
        let index = document.getElementById("questionInput").value;
        document.getElementById("questionInput").value = "";
        currentIndex = index - 1;
        showQuestion(currentIndex);
    }
}

// 첫 번째 질문 표시
showQuestion(currentIndex);