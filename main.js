const parseCSV = (csv) => {
    const rows = csv.trim().split('\n').slice(1);
    return rows.map(row => {
        const regex = /(".*?"|[^,]+)/g;
        return row.match(regex).map(item => item.replace(/(^"|"$)/g, ''));
    });
};

const parsedData = parseCSV(data);
let currentIndex = 0;

function showQuestion(index) {
    const questionContainer = document.getElementById('question-container');
    questionContainer.innerHTML = `
        <div class="card question-card">
            <div class="card-body">
                <h5 class="card-title">${parsedData[index][0]}. ${parsedData[index][1]}</h5>
                <ul class="list-group list-group-flush">
                    <li class="list-group-item">A) ${parsedData[index][2]}</li>
                    <li class="list-group-item">B) ${parsedData[index][3]}</li>
                    <li class="list-group-item">C) ${parsedData[index][4]}</li>
                    <li class="list-group-item">D) ${parsedData[index][5]}</li>
                    ${parsedData[index][8] ? `<li class="list-group-item">E) ${parsedData[index][6]}</li>` : ''}
                </ul>
                <div class="d-flex align-items-center mt-2">
                    <button class="btn btn-custom mt-3" onclick="toggleAnswer(this, '${parsedData[index][8] ? parsedData[index][7] : parsedData[index][6]}')">정답 보기</button>
                    <span class="answer ml-auto"></span> <!-- 오른쪽 끝으로 이동 -->
                </div>
                <div class="d-flex align-items-center mt-2">
                    <button class="btn btn-custom mt-3" onclick="toggleExplanation(this, '${parsedData[index][8] ? parsedData[index][8] : parsedData[index][7]}')">해설 보기</button>
                </div>
                <br>
                <div id="explanation" class="explanation ml-auto"></div> <!-- 해설 표시 -->
            </div>
        </div>
    `;

    // 버튼 표시 여부
    document.getElementById('prev-btn').style.display = index === 0 ? 'none' : 'inline-block';
    document.getElementById('next-btn').style.display = index === parsedData.length - 1 ? 'none' : 'inline-block';

    // 진행 상태 업데이트
    updateProgress(index);
}

function updateProgress(index) {
    const progress = document.getElementById('progress');
    progress.innerHTML = `문제 ${index + 1} / ${parsedData.length}`;
}

function toggleAnswer(button, answer) {
    const answerElement = button.nextElementSibling;
    if (answerElement.style.display === "none" || answerElement.style.display === "") {
        answerElement.style.display = "inline";
        answerElement.textContent = `정답: ${answer}`;
        button.textContent = "정답 숨기기";
    } else {
        answerElement.style.display = "none";
        button.textContent = "정답 보기";
    }
}

function toggleExplanation(button, explanation) {
    const explanationElement = document.getElementById('explanation');
    if (explanationElement.style.display === "none" || explanationElement.style.display === "") {
        explanationElement.style.display = "inline";
        explanationElement.textContent = `해설: ${explanation}`;
        button.textContent = "해설 숨기기";
    } else {
        explanationElement.style.display = "none";
        button.textContent = "해설 보기";
    }
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

// 첫 번째 질문 표시
showQuestion(currentIndex);
