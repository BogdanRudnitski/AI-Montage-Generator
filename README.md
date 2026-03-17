# FOR FIRST SETUP ONLY

cd app/backend
python3 -m venv venv

cd ../ai
python3 -m venv venv


# AFTER EVERY GIT PULL

# from source of project, i.e. from codejam15

cd app/clipgsm
npm install

# from source of project, i.e. from codejam15

cd app/backend
source venv/bin/activate
pip install -r requirements.txt

# open new terminal window inside IDE
# from source of project, i.e. from codejam15

cd app/ai
source venv/bin/activate
pip install -r requirements.txt



# TO RUN APP WITH BACKEND

# Open a terminal
# from source of project, i.e. from codejam15

cd app/backend
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000


# Open a 2nd terminal
# from source of project, i.e. from codejam15

cd app/clipgsm
npm run ios