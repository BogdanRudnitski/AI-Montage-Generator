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